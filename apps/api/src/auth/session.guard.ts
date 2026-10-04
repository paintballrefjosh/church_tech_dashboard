import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decode } from "@auth/core/jwt";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { SESSION_ONLY_KEY, READ_ONLY_PER_OPERATION_KEY } from "./session-only.decorator";
import { isReadMethod } from "./api-token-scope";
import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./current-user.decorator";
import { SettingsService } from "../settings/settings.service";

/**
 * Routes that remain reachable for a user whose `mustChangePassword` is true.
 * Pages can still render (GETs pass) and the user can submit the password
 * change. Everything else (mutating writes on other resources) is blocked so
 * a stolen seed-default cookie can't be used to modify state before the
 * operator changes the password.
 *
 * Paths are matched against the URL after stripping a leading "/api/v{N}".
 */
const MUST_CHANGE_PASSWORD_ALLOW: Array<{ method: string; path: string }> = [
  { method: "POST", path: "/me/change-password" },
];

function pathWithoutApiPrefix(url: string): string {
  const noQuery = url.split("?")[0] || "";
  return noQuery.replace(/^\/api\/v\d+/, "") || "/";
}

function enforceMustChangePassword(user: AuthenticatedUser, req: { method?: string; url?: string }): void {
  if (!user.mustChangePassword) return;
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const path = pathWithoutApiPrefix(req.url || "/");
  for (const allow of MUST_CHANGE_PASSWORD_ALLOW) {
    if (allow.method === method && allow.path === path) return;
  }
  throw new ForbiddenException("Password change required");
}

/**
 * Block a pending (awaiting-admin-approval) OAuth user from everything except
 * reading their own profile, so the web can render the "pending approval"
 * screen. They have no groups/permissions anyway; this also stops them seeing
 * any GET-able content while they wait.
 */
function enforceApproval(user: AuthenticatedUser, req: { method?: string; url?: string }): void {
  if (user.approvalStatus !== "pending") return;
  const method = (req.method || "GET").toUpperCase();
  const path = pathWithoutApiPrefix(req.url || "/");
  if (path === "/me" && (method === "GET" || method === "HEAD")) return;
  throw new ForbiddenException("Account pending approval");
}

/**
 * Block API access for any user who *must* have TOTP enrolled but doesn't.
 * Both knobs (`auth.require_totp_admin`, `auth.require_totp_all`) default to
 * off, so this only kicks in when an operator has flipped one on. When it
 * does kick in we still allow the TOTP enrolment + confirmation endpoints
 * through so the affected user can finish enrolling without an admin's help.
 */
function enforceTotpEnrollment(
  user: AuthenticatedUser,
  req: { method?: string; url?: string },
  flags: { requireAdmin: boolean; requireAll: boolean },
): void {
  if (user.totpEnabled) return;
  const isAdmin = user.groups.includes("admin");
  const required = flags.requireAll || (flags.requireAdmin && isAdmin);
  if (!required) return;
  const method = (req.method || "GET").toUpperCase();
  // Reads pass: pages can still render the "enrol TOTP" prompt and the
  // /me endpoint that drives it. Only mutations are blocked.
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const path = pathWithoutApiPrefix(req.url || "/");
  if (path === "/auth/totp/enroll" || path === "/auth/totp/confirm") return;
  throw new ForbiddenException("TOTP enrollment required");
}

/**
 * Tiny in-memory cache for the two TOTP-required flags. Reads twice per
 * authenticated request would mean hundreds of avoidable DB lookups under
 * normal browsing; settings are edited rarely so a short TTL is fine.
 * A broader settings cache is on the perf roadmap — when that lands, drop
 * this and read through the central cache instead.
 */
const AUTH_FLAG_TTL_MS = 30_000;
let authFlagCache: { at: number; requireAdmin: boolean; requireAll: boolean } | null = null;

async function loadAuthFlags(settings: SettingsService): Promise<{ requireAdmin: boolean; requireAll: boolean }> {
  const now = Date.now();
  if (authFlagCache && now - authFlagCache.at < AUTH_FLAG_TTL_MS) {
    return { requireAdmin: authFlagCache.requireAdmin, requireAll: authFlagCache.requireAll };
  }
  const [admin, all] = await Promise.all([
    settings.get("auth.require_totp_admin"),
    settings.get("auth.require_totp_all"),
  ]);
  const requireAdmin = admin === true;
  const requireAll = all === true;
  authFlagCache = { at: now, requireAdmin, requireAll };
  return { requireAdmin, requireAll };
}

/**
 * Auth.js v5 cookie names. The cookie *name itself* is used as the JWE salt,
 * so we must try each candidate name and pass it through to decode().
 */
const SESSION_COOKIE_CANDIDATES = [
  "authjs.session-token",
  "__Secure-authjs.session-token",
  "next-auth.session-token",
  "__Secure-next-auth.session-token",
];

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    // 1. Bearer (API tokens) — for scripts and agents. A request that sends a
    // bearer token is judged on that token alone: an unknown, revoked or
    // expired one is a 401, never a fall-through to the session cookie.
    const authHeader: string | undefined = req.headers?.authorization;
    if (authHeader?.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      const enabled = (await this.settings.get("auth.api_tokens_enabled")) !== false;
      const user = enabled ? await this.auth.findUserByApiToken(token, typeof req.ip === "string" ? req.ip : null) : null;
      if (!user) throw new UnauthorizedException("Invalid or expired API token");
      req.user = user;
      const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]);
      if (sessionOnly) throw new ForbiddenException("This endpoint needs a signed-in session, not an API token");
      enforceApproval(user, req);
      enforceMustChangePassword(user, req);
      // Bearer requests skip the TOTP-enrolment gate on purpose: a script
      // can't enrol, and minting a token is session-only, so it already
      // passed that gate.
      if (user.apiToken?.readOnly && !isReadMethod(req.method)) {
        // A route that multiplexes reads and writes over POST (the MCP
        // endpoint) opts out and refuses writes per operation instead.
        const perOperation = this.reflector.getAllAndOverride<boolean>(READ_ONLY_PER_OPERATION_KEY, [
          ctx.getHandler(),
          ctx.getClass(),
        ]);
        if (!perOperation) throw new ForbiddenException("This API token is read-only");
      }
      return true;
    }

    // 2. Auth.js JWT session cookie (decrypted using the shared AUTH_SECRET).
    const cookies: Record<string, string> = req.cookies ?? {};
    const secret = process.env.AUTH_SECRET;
    if (secret) {
      for (const name of SESSION_COOKIE_CANDIDATES) {
        const raw = cookies[name];
        if (!raw) continue;
        let user: AuthenticatedUser | null = null;
        try {
          const decoded = await decode({ token: raw, secret, salt: name });
          const userId = decoded?.sub;
          if (typeof userId === "string") {
            user = await this.auth.loadUserById(userId);
          }
        } catch {
          // Wrong cookie name / tampered token — try the next candidate.
          continue;
        }
        if (user) {
          req.user = user;
          // Enforcement must run OUTSIDE the decode try/catch: these throw a
          // 403 to deliberately block pending / must-change-password / TOTP-
          // required users. Inside the try, that 403 was swallowed and the
          // request fell through to a misleading 401 "No valid session".
          enforceApproval(user, req);
          enforceMustChangePassword(user, req);
          enforceTotpEnrollment(user, req, await loadAuthFlags(this.settings));
          return true;
        }
      }
    }

    throw new UnauthorizedException("No valid session");
  }
}
