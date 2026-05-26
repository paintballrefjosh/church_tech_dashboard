import { Injectable, type CanActivate, type ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { decode } from "@auth/core/jwt";
import { IS_PUBLIC_KEY } from "./public.decorator";
import { AuthService } from "./auth.service";

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
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    // 1. Bearer (API tokens) — for service-to-service / scripts.
    const authHeader: string | undefined = req.headers?.authorization;
    if (authHeader?.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      const user = await this.auth.findUserByApiToken(token);
      if (user) {
        req.user = user;
        return true;
      }
    }

    // 2. Auth.js JWT session cookie (decrypted using the shared AUTH_SECRET).
    const cookies: Record<string, string> = req.cookies ?? {};
    const secret = process.env.AUTH_SECRET;
    if (secret) {
      for (const name of SESSION_COOKIE_CANDIDATES) {
        const raw = cookies[name];
        if (!raw) continue;
        try {
          const decoded = await decode({ token: raw, secret, salt: name });
          const userId = decoded?.sub;
          if (typeof userId === "string") {
            const user = await this.auth.loadUserById(userId);
            if (user) {
              req.user = user;
              return true;
            }
          }
        } catch {
          // Try next cookie name
        }
      }
    }

    throw new UnauthorizedException("No valid session");
  }
}
