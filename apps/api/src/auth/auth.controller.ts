import { Controller, Post, Body, BadRequestException, UnauthorizedException, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { authenticator } from "otplib";
import { Public } from "./public.decorator";
import { AuthService } from "./auth.service";
import { DB, type Db } from "../db/db.module";
import { users, credentials } from "../db/schema";

/**
 * `identifier` is either an email address or a bare username. A bare username
 * (no "@") is treated as <username>@local — this is how the default "admin"
 * account is reachable as both "admin" and "admin@local".
 */
const verifyBodySchema = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
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
  constructor(private readonly auth: AuthService, @Inject(DB) private readonly db: Db) {}

  @Public()
  @Post("verify-credentials")
  async verifyCredentials(@Body() body: unknown) {
    const parsed = verifyBodySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { email: rawEmail, password, totp } = parsed.data;
    const email = normaliseIdentifier(rawEmail);

    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
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
      const secret = await this.auth.getTotpSecret(user.id);
      if (!secret) throw new UnauthorizedException("TOTP not configured");
      const valid = authenticator.check(totp, secret);
      if (!valid) throw new UnauthorizedException("Invalid TOTP");
    }

    return {
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        image: user.image,
        mustChangePassword: user.mustChangePassword,
      },
    };
  }
}
