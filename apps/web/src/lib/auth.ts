import NextAuth, { type NextAuthConfig, CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import MicrosoftEntraID from "next-auth/providers/microsoft-entra-id";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { createHash } from "node:crypto";
import { db, schema } from "./db";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://api:3001";

/**
 * Token gate for the API's internal-only endpoints (providers/internal,
 * users/ensure-default-group). Derived from AUTH_SECRET — already shared
 * between web and api via env_file — so the raw secret never travels.
 * Returns null if AUTH_SECRET is unset; callers handle that as "skip".
 */
function internalApiToken(): string | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  return createHash("sha256").update(`internal-api:${secret}`).digest("hex");
}

function internalHeaders(): Record<string, string> {
  const token = internalApiToken();
  return token ? { "x-internal-token": token } : {};
}

// Mirror of the DB column. Keep "fixed" out of the runtime type — older JWTs
// minted before 0010 may still carry it; normalisePageWidth coerces it back to
// "standard" so we never have to handle the legacy value downstream.
export type PageWidth = "fluid" | "narrow" | "standard" | "wide" | "custom";

function normalisePageWidth(value: unknown): PageWidth {
  if (value === "fluid" || value === "narrow" || value === "wide" || value === "custom") {
    return value;
  }
  return "standard";
}

/**
 * Provider configuration is sourced from the API's settings table (with env-var
 * overrides) at runtime. Fetched once per cache window so /admin/settings edits
 * take effect within a minute without needing a container restart.
 */
interface ProviderConfig {
  local: { enabled: boolean };
  google: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    workspaceDomain: string;
    allowExternalWithApproval: boolean;
  };
  microsoft: {
    enabled: boolean;
    clientId: string;
    clientSecret: string;
    tenant: string;
    allowedDomains: string[];
  };
}

const PROVIDER_CACHE_TTL_MS = 30_000;
let providerCache: { at: number; cfg: ProviderConfig } | null = null;

const DEFAULT_PROVIDER_CFG: ProviderConfig = {
  local: { enabled: true },
  google: {
    enabled: false,
    clientId: "",
    clientSecret: "",
    workspaceDomain: "",
    allowExternalWithApproval: false,
  },
  microsoft: { enabled: false, clientId: "", clientSecret: "", tenant: "common", allowedDomains: [] },
};

async function loadProviderConfig(): Promise<ProviderConfig> {
  const now = Date.now();
  if (providerCache && now - providerCache.at < PROVIDER_CACHE_TTL_MS) {
    return providerCache.cfg;
  }
  try {
    const res = await fetch(`${apiInternalUrl}/api/v1/auth/providers/internal`, {
      cache: "no-store",
      headers: internalHeaders(),
    });
    if (!res.ok) throw new Error(`provider config ${res.status}`);
    const cfg = (await res.json()) as ProviderConfig;
    providerCache = { at: now, cfg };
    return cfg;
  } catch {
    // API not yet up (e.g. cold start) — fall back to the safe defaults so the
    // sign-in page still renders. Do NOT cache the failure; retry next call.
    return DEFAULT_PROVIDER_CFG;
  }
}

/** Exported for the /signin page so it can render only the enabled buttons. */
export async function getProviderConfig(): Promise<ProviderConfig> {
  return loadProviderConfig();
}

function buildProviders(cfg: ProviderConfig) {
  const providers = [];
  if (cfg.google.enabled) {
    providers.push(
      Google({
        clientId: cfg.google.clientId,
        clientSecret: cfg.google.clientSecret,
        // `hd` restricts Google's account chooser to the workspace domain. Only
        // apply it when we're domain-locked; with approval mode on we must let
        // external accounts reach the consent screen (they're gated afterwards).
        authorization: {
          params: {
            hd:
              cfg.google.workspaceDomain && !cfg.google.allowExternalWithApproval
                ? cfg.google.workspaceDomain
                : undefined,
          },
        },
      }),
    );
  }
  if (cfg.microsoft.enabled) {
    providers.push(
      MicrosoftEntraID({
        clientId: cfg.microsoft.clientId,
        clientSecret: cfg.microsoft.clientSecret,
        issuer: `https://login.microsoftonline.com/${cfg.microsoft.tenant || "common"}/v2.0`,
      }),
    );
  }
  if (cfg.local.enabled) {
    providers.push(
      Credentials({
        name: "Local",
        credentials: {
          email: { label: "Email", type: "email" },
          password: { label: "Password", type: "password" },
          totp: { label: "TOTP", type: "text" },
        },
        async authorize(creds) {
          const payload = {
            email: typeof creds?.email === "string" ? creds.email : "",
            password: typeof creds?.password === "string" ? creds.password : "",
            totp: typeof creds?.totp === "string" && creds.totp.length > 0 ? creds.totp : undefined,
          };
          try {
            const res = await fetch(`${apiInternalUrl}/api/v1/auth/verify-credentials`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
              cache: "no-store",
            });
            if (!res.ok) {
              const body = (await res.json().catch(() => ({}))) as { code?: string };
              if (body.code === "account_deleted") throw new AccountDeletedSignin();
              return null;
            }
            const data = (await res.json()) as
              | {
                  ok: true;
                  user: {
                    id: string;
                    email: string;
                    name: string | null;
                    image: string | null;
                    mustChangePassword?: boolean;
                    pageWidth?: string;
                    pageWidthPx?: number | null;
                  };
                }
              | { ok: false; requiresTotp?: boolean };
            if (!data.ok) {
              if ("requiresTotp" in data && data.requiresTotp) {
                throw new Error("TOTP_REQUIRED");
              }
              return null;
            }
            return {
              id: data.user.id,
              email: data.user.email,
              name: data.user.name,
              image: data.user.image,
              mustChangePassword: data.user.mustChangePassword === true,
              pageWidth: normalisePageWidth(data.user.pageWidth),
              pageWidthPx:
                typeof data.user.pageWidthPx === "number" ? data.user.pageWidthPx : null,
            } as never;
          } catch (err) {
            if (err instanceof AccountDeletedSignin) throw err;
            if (err instanceof Error && err.message === "TOTP_REQUIRED") throw err;
            return null;
          }
        },
      }),
    );
  }
  return providers;
}

type ProvisionStatus = "approved" | "pending" | "rejected" | "deleted";

/**
 * Thrown from the Credentials `authorize()` when the API reports the account is
 * soft-deleted. Auth.js appends `code` to the redirect as `&code=account_deleted`,
 * which the sign-in page maps to a specific message.
 */
class AccountDeletedSignin extends CredentialsSignin {
  override code = "account_deleted";
}

/**
 * Ask the API to provision a just-authenticated OAuth user: approve + add to
 * the default group, hold as pending admin approval, or reject the sign-in.
 * Fails CLOSED to "pending" on a transient API error: an un-provisioned user
 * has no group and the DB row may still carry the schema default "approved", so
 * approving here would silently grant access to someone who was never gated.
 * Pending is safe — the user lands on /pending, and the next successful sign-in
 * re-provisions them (workspace users self-heal to approved; external accounts
 * await an admin decision, which is the intended behaviour).
 */
async function provisionOAuthUser(input: {
  userId: string;
  email: string;
  provider: string;
}): Promise<ProvisionStatus> {
  try {
    const res = await fetch(`${apiInternalUrl}/api/v1/users/oauth-provision`, {
      method: "POST",
      headers: { "content-type": "application/json", ...internalHeaders() },
      body: JSON.stringify(input),
      cache: "no-store",
    });
    if (!res.ok) return "pending";
    const data = (await res.json()) as { status?: ProvisionStatus };
    return data.status ?? "pending";
  } catch {
    return "pending";
  }
}

function emailDomain(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

/**
 * Build the auth config from current provider settings. NextAuth v5 supports
 * passing a function here, so this is re-evaluated per request — providers
 * track the settings table within the cache TTL.
 */
async function buildAuthConfig(): Promise<NextAuthConfig> {
  const cfg = await loadProviderConfig();
  return {
    adapter: DrizzleAdapter(db, {
      usersTable: schema.users,
      accountsTable: schema.accounts,
      sessionsTable: schema.sessions,
      verificationTokensTable: schema.verificationTokens,
    }),
    session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 }, // 14 days
    trustHost: true,
    pages: { signIn: "/signin" },
    providers: buildProviders(cfg),
    // Provisioning runs in TWO phases (see provisionOAuthUser on the API):
    //   - `signIn` callback (below): authorises the sign-in (allow/deny) and
    //     stamps the JWT. For a brand-new user this runs BEFORE the adapter has
    //     persisted the row, so the API returns the decision only (no writes).
    //   - `events.signIn` (below): fires AFTER persistence, so the API can
    //     actually grant the default group + set the approval status without
    //     tripping the users FK. Idempotent, so returning users are a no-op.
    callbacks: {
      async signIn({ account, profile, user }) {
        const provider = account?.provider;
        if (provider !== "google" && provider !== "microsoft-entra-id") return true;

        // Microsoft email-domain allowlist (blank = allow any). Google's domain
        // policy is handled by oauth-provision below (which can also gate
        // external accounts to a pending state).
        if (provider === "microsoft-entra-id" && cfg.microsoft.allowedDomains.length) {
          const dom = emailDomain(
            (profile as { email?: string; preferred_username?: string } | undefined)?.email ??
              (profile as { preferred_username?: string } | undefined)?.preferred_username ??
              user?.email,
          );
          if (!cfg.microsoft.allowedDomains.includes(dom)) return false;
        }

        if (!user?.id) return true;
        const email =
          (profile as { email?: string } | undefined)?.email ?? user.email ?? "";
        const status = await provisionOAuthUser({
          userId: user.id,
          email,
          provider: provider === "google" ? "google" : "microsoft",
        });
        if (status === "rejected") return false;
        // Soft-deleted account: deny and route to a specific message rather than
        // silently resurrecting the row a returning OAuth identity still links to.
        if (status === "deleted") return "/signin?error=AccountDeleted";
        // Stash for the jwt callback (same request) so the session reflects a
        // pending gate immediately on first sign-in, not one navigation late.
        (user as { approvalStatus?: "approved" | "pending" }).approvalStatus =
          status === "pending" ? "pending" : "approved";
        return true;
      },
      async jwt({ token, user, trigger, session }) {
        if (user?.id) {
          token.sub = user.id;
          const mcp = (user as { mustChangePassword?: boolean }).mustChangePassword;
          if (typeof mcp === "boolean") {
            (token as { mustChangePassword?: boolean }).mustChangePassword = mcp;
          }
          const as = (user as { approvalStatus?: string }).approvalStatus;
          (token as { approvalStatus?: "approved" | "pending" }).approvalStatus =
            as === "pending" ? "pending" : "approved";
          const pw = (user as { pageWidth?: string }).pageWidth;
          const px = (user as { pageWidthPx?: number | null }).pageWidthPx;
          const t = token as { pageWidth?: PageWidth; pageWidthPx?: number | null };
          t.pageWidth = normalisePageWidth(pw);
          t.pageWidthPx = typeof px === "number" ? px : null;
        }
        if (trigger === "update" && session && typeof session === "object") {
          const s = session as { pageWidth?: unknown; pageWidthPx?: unknown };
          const t = token as { pageWidth?: PageWidth; pageWidthPx?: number | null };
          if (typeof s.pageWidth === "string") {
            t.pageWidth = normalisePageWidth(s.pageWidth);
          }
          if (s.pageWidthPx === null) t.pageWidthPx = null;
          else if (typeof s.pageWidthPx === "number") t.pageWidthPx = s.pageWidthPx;
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.sub) {
          const u = session.user as {
            id?: string;
            mustChangePassword?: boolean;
            approvalStatus?: "approved" | "pending";
            pageWidth?: PageWidth;
            pageWidthPx?: number | null;
          };
          u.id = token.sub;
          u.mustChangePassword =
            (token as { mustChangePassword?: boolean }).mustChangePassword === true;
          u.approvalStatus =
            (token as { approvalStatus?: "approved" | "pending" }).approvalStatus === "pending"
              ? "pending"
              : "approved";
          const t = token as { pageWidth?: PageWidth; pageWidthPx?: number | null };
          u.pageWidth = normalisePageWidth(t.pageWidth);
          u.pageWidthPx = typeof t.pageWidthPx === "number" ? t.pageWidthPx : null;
        }
        return session;
      },
    },
    events: {
      // Runs after the adapter has persisted the user + linked the account, so
      // the API's group-grant + approval write won't hit the users FK. This is
      // what actually provisions a brand-new OAuth user (the signIn callback
      // ran too early to write). Best-effort: a failure here just means the
      // next sign-in re-provisions (idempotent).
      async signIn({ user, account, profile }) {
        const provider = account?.provider;
        if (provider !== "google" && provider !== "microsoft-entra-id") return;
        if (!user?.id) return;
        const email = (profile as { email?: string } | undefined)?.email ?? user.email ?? "";
        await provisionOAuthUser({
          userId: user.id,
          email,
          provider: provider === "google" ? "google" : "microsoft",
        });
      },
    },
  };
}

const nextAuth = NextAuth(buildAuthConfig);
export const { auth, signIn } = nextAuth;

/**
 * Next.js standalone constructs req.url from the bind address ($HOSTNAME:$PORT,
 * e.g. http://0.0.0.0:3000/...), not from the incoming Host header. Auth.js
 * uses that req.url to build OAuth callbacks, sign-in redirects, and cookie
 * domains — which leaks the internal bind address out to the user's browser
 * and breaks sign-in entirely when the app is accessed from a remote machine.
 *
 * To keep this fully dynamic — same image works at localhost, a LAN IP, a
 * real domain, behind an HTTPS LB — we rewrite the URL using the public origin
 * derived from X-Forwarded-Host (set by Caddy) before Auth.js sees the request.
 * AUTH_URL stays unset on purpose so this is the only origin-derivation logic.
 */
function withPublicOriginRewrite(handler: (req: Request) => Promise<Response> | Response) {
  return async (req: Request) => {
    const xfHost = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (!xfHost) return handler(req);
    const xfProto =
      (req.headers.get("x-forwarded-proto") ?? "http").split(",")[0]?.trim() ?? "http";
    const reqUrl = new URL(req.url);
    const fixed = new URL(reqUrl.pathname + reqUrl.search, `${xfProto}://${xfHost}`);
    if (fixed.toString() === reqUrl.toString()) return handler(req);
    return handler(new Request(fixed.toString(), req));
  };
}

export const handlers = {
  GET: withPublicOriginRewrite(nextAuth.handlers.GET as never),
  POST: withPublicOriginRewrite(nextAuth.handlers.POST as never),
};
