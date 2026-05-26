import NextAuth, { type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { db, schema } from "./db";

const apiInternalUrl = process.env.API_INTERNAL_URL ?? "http://api:3001";
const localAuthEnabled = process.env.AUTH_DISABLE_LOCAL !== "true";
const googleEnabled = !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const workspaceDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;

export const authConfig: NextAuthConfig = {
  adapter: DrizzleAdapter(db, {
    usersTable: schema.users,
    accountsTable: schema.accounts,
    sessionsTable: schema.sessions,
    verificationTokensTable: schema.verificationTokens,
  }),
  session: { strategy: "jwt", maxAge: 60 * 60 * 24 * 14 }, // 14 days
  trustHost: true,
  pages: {
    signIn: "/signin",
  },
  providers: [
    ...(googleEnabled
      ? [
          Google({
            clientId: process.env.GOOGLE_OAUTH_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET!,
            authorization: { params: { hd: workspaceDomain ?? undefined } },
          }),
        ]
      : []),
    ...(localAuthEnabled
      ? [
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
                if (!res.ok) return null;
                const data = (await res.json()) as
                  | { ok: true; user: { id: string; email: string; name: string | null; image: string | null; mustChangePassword?: boolean } }
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
                  // Persisted onto the JWT below so the layout can force a redirect.
                  mustChangePassword: data.user.mustChangePassword === true,
                } as never;
              } catch (err) {
                if (err instanceof Error && err.message === "TOTP_REQUIRED") throw err;
                return null;
              }
            },
          }),
        ]
      : []),
  ],
  callbacks: {
    async signIn({ account, profile }) {
      if (account?.provider === "google" && workspaceDomain) {
        const hd = (profile as { hd?: string } | undefined)?.hd;
        if (hd !== workspaceDomain) return false;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        const mcp = (user as { mustChangePassword?: boolean }).mustChangePassword;
        if (typeof mcp === "boolean") {
          (token as { mustChangePassword?: boolean }).mustChangePassword = mcp;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        (session.user as { id?: string; mustChangePassword?: boolean }).id = token.sub;
        (session.user as { id?: string; mustChangePassword?: boolean }).mustChangePassword =
          (token as { mustChangePassword?: boolean }).mustChangePassword === true;
      }
      return session;
    },
  },
};

const nextAuth = NextAuth(authConfig);
export const { auth, signIn, signOut } = nextAuth;

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
