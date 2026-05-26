import { Controller, Post, Get, Body, BadRequestException, ForbiddenException, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authenticator } from "otplib";
import QRCode from "qrcode";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";
import { AuthService } from "./auth.service";
import { DB, type Db } from "../db/db.module";
import { users, totpSecrets } from "../db/schema";

const verifyBody = z.object({ code: z.string().regex(/^\d{6}$/) });

@Controller("auth/totp")
export class TotpController {
  constructor(private readonly auth: AuthService, @Inject(DB) private readonly db: Db) {}

  @Post("enroll")
  async enroll(@CurrentUser() user: AuthenticatedUser) {
    if (user.totpEnabled) throw new ForbiddenException("TOTP already enrolled");
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(user.email, "Church Dashboard", secret);
    const qrSvg = await QRCode.toString(otpauth, { type: "svg", margin: 1 });

    await this.db
      .insert(totpSecrets)
      .values({ userId: user.id, secret })
      .onConflictDoUpdate({ target: totpSecrets.userId, set: { secret, enrolledAt: new Date() } });

    return { otpauth, qr: qrSvg };
  }

  @Post("confirm")
  async confirm(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { code } = verifyBody.parse(body);
    const secret = await this.auth.getTotpSecret(user.id);
    if (!secret) throw new BadRequestException("Run enroll first");
    if (!authenticator.check(code, secret)) throw new BadRequestException("Invalid code");
    await this.db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    return { ok: true };
  }

  @Get("status")
  status(@CurrentUser() user: AuthenticatedUser) {
    return { enabled: user.totpEnabled };
  }
}
