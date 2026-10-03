import { Controller, Get, Post, Body, BadRequestException, UnauthorizedException, Inject, Req } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticator } from "otplib";
import { PERMISSIONS } from "@church/shared";
import { Public } from "./public.decorator";
import { RequirePermissions } from "./permissions.decorator";
import { AuthService } from "./auth.service";
import { assertInternalCaller } from "./internal-token";
import { SettingsService } from "../settings/settings.service";
import { DB, type Db } from "../db/db.module";
import { users, credentials, totpSecrets } from "../db/schema";

const googleTestBodySchema = z.object({
  clientId: z.string().max(256).optional(),
  clientSecret: z.string().max(512).optional(),
});

/** Shape returned by /auth/providers/internal. Mirrors what Auth.js needs to
 *  construct the provider list on the web side. Secrets are included because
 *  the endpoint is double-gated (Caddy 404s the path externally + the
 *  controller requires a shared X-Internal-Token derived from AUTH_SECRET). */
interface ProviderConfigResponse {
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

/**
 * `identifier` is either an email address or a bare username. A bare username
 * (no "@") is treated as <username>@local — this is how the default "admin"
 * account is reachable as both "admin" and "admin@local".
 */
const verifyBodySchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1),
  // Either a 6-digit TOTP code OR a recovery code (5×4 chars + dashes). The
  // server accepts whichever the user sends in the same field.
  totp: z.string().min(6).max(40).optional(),
});

function normaliseIdentifier(input: string): string {
  return input.includes("@") ? input.toLowerCase().trim() : `${input.toLowerCase().trim()}@local`;
}

/**
 * Endpoints used by Auth.js (Credentials provider on the web side) to verify
 * local credentials. NOT for direct browser use — call from the web service.
 */
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly settingsSvc: SettingsService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Check a recovery code against the stored hashed list. Single-use:
   * matched codes are removed from the array before returning so they
   * can't be replayed. Returns true on a successful consume.
   */
  private async consumeRecoveryCode(userId: string, plaintext: string): Promise<boolean> {
    const hash = createHash("sha256")
      .update(plaintext.toUpperCase().replace(/-/g, ""))
      .digest("hex");
    const [row] = await this.db
      .select({ id: totpSecrets.userId, codes: totpSecrets.recoveryCodes })
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .limit(1);
    const codes = row?.codes ?? [];
    if (!codes.includes(hash)) return false;
    const remaining = codes.filter((c) => c !== hash);
    await this.db
      .update(totpSecrets)
      .set({ recoveryCodes: remaining })
      .where(eq(totpSecrets.userId, userId));
    return true;
  }

  @Public()
  @Post("verify-credentials")
  async verifyCredentials(@Body() body: unknown) {
    const parsed = verifyBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { email: rawEmail, password, totp } = parsed.data;
    const email = normaliseIdentifier(rawEmail);

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (user?.deletedAt) {
      // Stable `code` lets the web Credentials authorize() surface a specific
      // message ("account has been deleted") rather than the generic one.
      throw new UnauthorizedException({
        statusCode: 401,
        message: "This account has been deleted. Contact an administrator.",
        code: "account_deleted",
      });
    }
    if (!user || !user.isActive) throw new UnauthorizedException("Invalid credentials");

    const [cred] = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.userId, user.id))
      .limit(1);
    if (!cred) throw new UnauthorizedException("Invalid credentials");

    const ok = await this.auth.verifyPassword(cred.passwordHash, password);
    if (!ok) throw new UnauthorizedException("Invalid credentials");

    if (user.totpEnabled) {
      if (!totp) return { ok: false, requiresTotp: true };
      // Distinguish: 6 pure digits → TOTP code; anything else → treat as a
      // recovery code. Recovery codes are normalised (uppercase, dashes
      // stripped) before hashing for the comparison.
      const isDigits6 = /^\d{6}$/.test(totp);
      if (isDigits6) {
        const secret = await this.auth.getTotpSecret(user.id);
        if (!secret) throw new UnauthorizedException("TOTP not configured");
        const valid = authenticator.check(totp, secret);
        if (!valid) throw new UnauthorizedException("Invalid TOTP");
      } else {
        const ok = await this.consumeRecoveryCode(user.id, totp);
        if (!ok) throw new UnauthorizedException("Invalid TOTP");
      }
    }

    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        mustChangePassword: user.mustChangePassword,
        pageWidth: user.pageWidth,
        pageWidthPx: user.pageWidthPx,
      },
    };
  }

  /**
   * Reads OAuth provider configuration from the settings table and returns the
   * resolved config (including secrets) for the web service's Auth.js setup.
   *
   * @Public because the web service has no session at the moment it bootstraps
   * the auth config — but the caller must present a valid X-Internal-Token
   * (sha256("internal-api:" + AUTH_SECRET)). The Caddyfile also 404s the
   * path on the public proxy as defence-in-depth.
   */
  @Public()
  @Get("providers/internal")
  async providersInternal(@Req() req: { headers?: Record<string, string | string[] | undefined> }): Promise<ProviderConfigResponse> {
    assertInternalCaller(req);
    const get = async (key: string): Promise<string> => {
      const raw = await this.settingsSvc.get(key);
      return typeof raw === "string" ? raw : "";
    };
    const getBool = async (key: string, fallback: boolean): Promise<boolean> => {
      const raw = await this.settingsSvc.get(key);
      if (typeof raw === "boolean") return raw;
      return fallback;
    };

    // All OAuth credentials live in the `settings` table — editable at
    // /admin/settings/google and /admin/settings/microsoft without a redeploy.
    // We deliberately don't fall back to env vars: a stale env value would
    // silently shadow whatever the operator set in the UI.
    const googleClientId = await get("google.oauth.client_id");
    const googleClientSecret = await get("google.oauth.client_secret");
    const googleDomain = await get("google.workspace_domain");
    const googleAllowExternal = await getBool("google.allow_external_with_approval", false);

    const microsoftClientId = await get("microsoft.oauth.client_id");
    const microsoftClientSecret = await get("microsoft.oauth.client_secret");
    const microsoftTenant = (await get("microsoft.oauth.tenant")) || "common";
    const microsoftDomains = (await get("microsoft.allowed_domains"))
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    return {
      local: { enabled: await getBool("auth.local.enabled", true) },
      google: {
        enabled:
          (await getBool("auth.google.enabled", true)) && !!googleClientId && !!googleClientSecret,
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        workspaceDomain: googleDomain,
        allowExternalWithApproval: googleAllowExternal,
      },
      microsoft: {
        enabled:
          (await getBool("auth.microsoft.enabled", false)) &&
          !!microsoftClientId &&
          !!microsoftClientSecret,
        clientId: microsoftClientId,
        clientSecret: microsoftClientSecret,
        tenant: microsoftTenant,
        allowedDomains: microsoftDomains,
      },
    };
  }

  /**
   * Admin "Test connection" button on the Google OAuth settings page. Verifies
   * the configured client_id/client_secret are recognised by Google by hitting
   * the token endpoint with a deliberately-bogus authorisation code:
   *   - `invalid_grant` / `invalid_request` → the credentials are valid (Google
   *     accepted the auth and only rejected the grant itself).
   *   - `invalid_client` / `unauthorized_client` → Google rejected the
   *     credentials themselves.
   *
   * Either field left undefined in the body falls back to the stored value.
   */
  @Post("google/test")
  @RequirePermissions(PERMISSIONS.SITE_ADMIN)
  async testGoogleOAuth(@Body() body: unknown): Promise<{ ok: boolean; message: string }> {
    const parsed = googleTestBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const storedId = (await this.settingsSvc.get("google.oauth.client_id")) as string | undefined;
    const storedSecret = (await this.settingsSvc.get("google.oauth.client_secret")) as string | undefined;
    const clientId = parsed.data.clientId?.trim() || storedId || "";
    const clientSecret = parsed.data.clientSecret || storedSecret || "";
    if (!clientId || !clientSecret) {
      return { ok: false, message: "Both client ID and client secret are required" };
    }
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: "church-dashboard-credential-test",
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "http://localhost/test",
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      let payload: { error?: string; error_description?: string } = {};
      try {
        payload = JSON.parse(text) as typeof payload;
      } catch {
        /* Google returns JSON on the token endpoint, but be defensive */
      }
      // Anything other than `invalid_client`/`unauthorized_client` means Google
      // *recognised* the credentials and stopped short on the (deliberately
      // bogus) grant. That's the success signal we're looking for.
      if (payload.error === "invalid_client" || payload.error === "unauthorized_client") {
        return {
          ok: false,
          message: `Google rejected the credentials: ${payload.error_description ?? payload.error}`,
        };
      }
      if (payload.error === "invalid_grant" || payload.error === "invalid_request") {
        return { ok: true, message: "Client ID + secret accepted by Google" };
      }
      if (!res.ok) {
        return {
          ok: false,
          message: `Unexpected Google response (HTTP ${res.status}): ${payload.error_description ?? payload.error ?? text.slice(0, 200)}`,
        };
      }
      return {
        ok: false,
        message: "Google didn't return the expected error — credentials may be misconfigured",
      };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") return { ok: false, message: "Connection to Google timed out" };
      return { ok: false, message: e.message || String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}
