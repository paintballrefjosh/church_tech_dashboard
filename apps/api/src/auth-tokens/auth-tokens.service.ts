import { Injectable, Inject, BadRequestException, Logger } from "@nestjs/common";
import { and, eq, isNull, gte, ne } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { DB, type Db } from "../db/db.module";
import { authTokens, users, credentials } from "../db/schema";
import { AuthService } from "../auth/auth.service";
import { MailerService } from "../mailer/mailer.service";
import { renderEmail } from "../mailer/templates";
import { SettingsService } from "../settings/settings.service";

const INVITE_TTL_HOURS = 72;
const RESET_TTL_HOURS = 2;
/** A person asking for a reset again within this time gets no second email (mail-bombing and token-flooding guard). */
const RESET_MIN_INTERVAL_MS = 5 * 60_000;

export type TokenKind = "invite" | "reset";

@Injectable()
export class AuthTokensService {
  private readonly logger = new Logger(AuthTokensService.name);

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
    if (kind === "reset") {
      // The public "forgot password" form calls this for anyone who knows an address: one live reset link per
      // account per few minutes, however often it is asked for.
      const [recent] = await this.db
        .select({ id: authTokens.id })
        .from(authTokens)
        .where(
          and(
            eq(authTokens.userId, userId),
            eq(authTokens.kind, "reset"),
            isNull(authTokens.usedAt),
            gte(authTokens.createdAt, new Date(Date.now() - RESET_MIN_INTERVAL_MS)),
          ),
        )
        .limit(1);
      if (recent) return { email: user.email };
    }
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
    if (!base) {
      this.logger.warn(
        `The ${kind} email for ${user.email} has a relative link that will not open: set "Site URL" in Site settings (or APP_URL).`,
      );
    }
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
   * + clear mustChangePassword, end the account's sessions. Returns the affected userId.
   *
   * The token is claimed with one conditional UPDATE before anything else, so of two simultaneous requests
   * with the same link exactly one proceeds. A token for an account that is disabled or deleted is spent
   * and refused.
   */
  async consume(plaintext: string, newPassword: string): Promise<{ userId: string }> {
    if (newPassword.length < 8) throw new BadRequestException("Password too short");
    const tokenHash = this.hashToken(plaintext);
    const [claimed] = await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.tokenHash, tokenHash), isNull(authTokens.usedAt), gte(authTokens.expiresAt, new Date())))
      .returning({ id: authTokens.id, userId: authTokens.userId });
    if (!claimed) throw new BadRequestException("Invalid or expired token");

    const [owner] = await this.db
      .select({ isActive: users.isActive, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, claimed.userId))
      .limit(1);
    if (!owner || !owner.isActive || owner.deletedAt) throw new BadRequestException("Invalid or expired token");

    const hash = await this.auth.hashPassword(newPassword);
    await this.db
      .insert(credentials)
      .values({ userId: claimed.userId, passwordHash: hash })
      .onConflictDoUpdate({
        target: credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
    await this.db
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, claimed.userId));
    // Any other link still outstanding for the account (an older reset, an unused invite) dies with this one.
    await this.db
      .update(authTokens)
      .set({ usedAt: new Date() })
      .where(and(eq(authTokens.userId, claimed.userId), isNull(authTokens.usedAt), ne(authTokens.id, claimed.id)));
    await this.auth.revokeSessions(claimed.userId);
    return { userId: claimed.userId };
  }
}
