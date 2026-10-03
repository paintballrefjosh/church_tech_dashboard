import { Controller, Post, Get, Delete, Body, BadRequestException, ForbiddenException, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { createHash, randomBytes } from "node:crypto";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";
import { AuthService } from "./auth.service";
import { DB, type Db } from "../db/db.module";
import { users, totpSecrets } from "../db/schema";

const verifyBody = z.object({ code: z.string().regex(/^\d{6}$/) });

/**
 * Recovery code format: 5 groups of 4 base32-ish chars joined by '-' (so it
 * fits comfortably on a printed card and is easy to dictate over the phone).
 * Stored as sha256 hashes so a DB read alone yields no usable codes.
 */
const RECOVERY_CODE_COUNT = 10;
function generateRecoveryCodes(): string[] {
  const out: string[] = [];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // base32 minus ambiguous 0/O/1/I
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const buf = randomBytes(20);
    const chars: string[] = [];
    for (let j = 0; j < 20; j++) chars.push(alphabet[buf[j]! % alphabet.length] ?? "X");
    out.push(`${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}`);
  }
  return out;
}
function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/-/g, "")).digest("hex");
}

@Controller("auth/totp")
export class TotpController {
  constructor(private readonly auth: AuthService, @Inject(DB) private readonly db: Db) {}

  @Post("enroll")
  async enroll(@CurrentUser() user: AuthenticatedUser) {
    if (user.totpEnabled) throw new ForbiddenException("TOTP already enrolled");
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, "Church Dashboard", secret);
    const qrSvg = await QRCode.toString(otpauth, { type: "svg", margin: 1 });

    // Generate one-shot recovery codes alongside the secret. Plain values
    // are returned ONCE here and never again — the DB only stores hashes.
    // The web client must show these to the user immediately and let them
    // copy/print/save; we cannot re-display them later.
    const recoveryPlain = generateRecoveryCodes();
    const recoveryHashes = recoveryPlain.map(hashRecoveryCode);

    await this.db
      .insert(totpSecrets)
      .values({ userId: user.id, secret, recoveryCodes: recoveryHashes })
      .onConflictDoUpdate({
        target: totpSecrets.userId,
        set: { secret, recoveryCodes: recoveryHashes, enrolledAt: new Date() },
      });

    return { otpauth, qr: qrSvg, recoveryCodes: recoveryPlain };
  }

  @Post("confirm")
  async confirm(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { code } = verifyBody.parse(body);
    const secret = await this.auth.getTotpSecret(user.id);
    if (!secret) throw new BadRequestException("Run enroll first");
    if (!authenticator.check(code, secret)) throw new BadRequestException("Invalid code");
    await this.db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    this.auth.invalidateUser(user.id);
    return { ok: true };
  }

  @Get("status")
  status(@CurrentUser() user: AuthenticatedUser) {
    return { enabled: user.totpEnabled };
  }

  /**
   * Disable TOTP for the calling user. Requires a current valid code so a
   * stolen session can't trivially remove the second factor. If
   * `auth.require_totp_admin` (or `auth.require_totp_all`) is enabled and
   * applies to this user, the SessionGuard will then refuse mutating
   * requests until they re-enrol via /auth/totp/enroll.
   */
  @Delete()
  async disable(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    if (!user.totpEnabled) throw new BadRequestException("TOTP not enrolled");
    const { code } = verifyBody.parse(body);
    const secret = await this.auth.getTotpSecret(user.id);
    if (!secret || !authenticator.check(code, secret)) {
      throw new BadRequestException("Invalid code");
    }
    await this.db.update(users).set({ totpEnabled: false }).where(eq(users.id, user.id));
    await this.db.delete(totpSecrets).where(eq(totpSecrets.userId, user.id));
    this.auth.invalidateUser(user.id);
    return { ok: true };
  }
}
