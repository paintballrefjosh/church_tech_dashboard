import { Injectable, Inject, BadRequestException } from "@nestjs/common";
import { and, eq, isNull, gte } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { DB, type Db } from "../db/db.module";
import { authTokens, users, credentials } from "../db/schema";
import { AuthService } from "../auth/auth.service";
import { MailerService } from "../mailer/mailer.service";
import { renderEmail } from "../mailer/templates";
import { SettingsService } from "../settings/settings.service";

const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 2;

export type TokenKind = "invite" | "reset";

@Injectable()
export class AuthTokensService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
    private readonly settings: SettingsService,
  ) {}

  /** SHA-256 of the bearer token — same scheme used for API tokens. */
  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  /**
   * Create and email a single-use token for either an invite (new user
   * who hasn't set a password yet) or a password reset.
   *
   * Returns the *email address* it was sent to; the plaintext token only
   * leaves the function in the email body, never in the response.
   */
  async issue(kind: TokenKind, userId: string, fallbackOrigin?: string): Promise<{ email: string }> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new BadRequestException("user not found");
    const ttlHours: number = kind === "invite" ? INVITE_TTL_HOURS : RESET_TTL_HOURS;
    const plaintext = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
    await this.db.insert(authTokens).values({
      userId,
      kind,
      tokenHash: this.hashToken(plaintext),
      expiresAt,
    });

    const siteName = ((await this.settings.get("site.name")) as string) || "Church Dashboard";
    // Both invite and reset land on the same /set-password page — it reads the
    // token from the query string and posts it to /auth/tokens/consume.
    const path = "/set-password";
    // The link must hit the operator's actual hostname: configured `site.url`
    // wins, then APP_URL, then a caller-supplied origin (e.g. the admin's
    // browser origin at create time). If none is known the email carries a
    // relative path + token — the operator should fix that by setting Site URL.
    const base = await this.settings.publicBaseUrl(fallbackOrigin);
    const link = `${base}${path}?token=${plaintext}`;
    const subject =
      kind === "invite"
        ? `You're invited to ${siteName}`
        : `Reset your ${siteName} password`;
    const rendered = renderEmail({
      siteName,
      title: subject,
      body:
        kind === "invite"
          ? `Welcome! Set your ${siteName} password to finish creating your account.`
          : `Use the link below to set a new ${siteName} password.`,
      cta: { label: kind === "invite" ? "Set password" : "Reset password", href: link },
      footer: `This link expires in ${ttlHours} hour${ttlHours === 1 ? "" : "s"} and can only be used once.`,
    });
    await this.mailer.sendBestEffort({
      to: user.email,
      subject,
      text: rendered.text,
      html: rendered.html,
    });
    return { email: user.email };
  }

  /**
   * Consume a plaintext token: validate, mark used, set the user's password
   * + clear mustChangePassword. Returns the affected userId.
   */
  async consume(plaintext: string, newPassword: string): Promise<{ userId: string }> {
    if (newPassword.length < 8) throw new BadRequestException("Password too short");
    const tokenHash = this.hashToken(plaintext);
    const [row] = await this.db
      .select()
      .from(authTokens)
      .where(
        and(
          eq(authTokens.tokenHash, tokenHash),
          isNull(authTokens.usedAt),
          gte(authTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException("Invalid or expired token");

    const hash = await this.auth.hashPassword(newPassword);
    await this.db
      .insert(credentials)
      .values({ userId: row.userId, passwordHash: hash })
      .onConflictDoUpdate({
        target: credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
    await this.db
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, row.userId));
    await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(eq(authTokens.id, row.id));
    this.auth.invalidateUser(row.userId);
    return { userId: row.userId };
  }
}
