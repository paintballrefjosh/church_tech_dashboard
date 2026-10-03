import { Body, Controller, Post, BadRequestException, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Public } from "../auth/public.decorator";
import { Audited } from "../audit/audit.decorator";
import { DB, type Db } from "../db/db.module";
import { users } from "../db/schema";
import { AuthTokensService } from "./auth-tokens.service";

const inviteBody = z.object({ userId: z.string().uuid() });
const requestResetBody = z.object({ email: z.string().email().max(254) });
const consumeBody = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(8).max(256),
});

@Controller("auth/tokens")
export class AuthTokensController {
  constructor(
    private readonly tokens: AuthTokensService,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * Admin-only: re-send an invite link to an existing user. The user must
   * already exist (admin-created via the users page); this just emails them
   * a one-shot link to set their password.
   */
  @Post("invite")
  @RequirePermissions(PERMISSIONS.USER_ADMIN)
  @Audited({ action: "auth.invite", resourceType: "user" })
  async invite(@Body() body: unknown) {
    const parsed = inviteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tokens.issue("invite", parsed.data.userId);
  }

  /**
   * Public: "forgot password" entry point. Always returns ok so an attacker
   * can't enumerate which emails are registered. The actual issue happens
   * only when the email matches an active user.
   */
  @Public()
  @Post("request-reset")
  async requestReset(@Body() body: unknown) {
    const parsed = requestResetBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid request");
    // We need to look up the user without exposing existence. Do the work
    // best-effort and always respond the same way.
    try {
      const [user] = await this.db
        .select({ id: users.id, isActive: users.isActive })
        .from(users)
        .where(eq(users.email, parsed.data.email.toLowerCase()))
        .limit(1);
      if (user?.isActive) await this.tokens.issue("reset", user.id);
    } catch {
      /* swallow */
    }
    return { ok: true };
  }

  /** Public: consume a token (sets the new password). */
  @Public()
  @Post("consume")
  @Audited({ action: "auth.token.consume", resourceType: "user" })
  async consume(@Body() body: unknown) {
    const parsed = consumeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tokens.consume(parsed.data.token, parsed.data.newPassword);
  }
}
