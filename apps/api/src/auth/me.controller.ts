import { Controller, Get, Post, Body, BadRequestException, Inject } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";
import { AuthService } from "./auth.service";
import { DB, type Db } from "../db/db.module";
import { users, credentials } from "../db/schema";
import { Audited } from "../audit/audit.decorator";

const changePasswordBody = z.object({
  newPassword: z.string().min(8).max(256),
});

@Controller("me")
export class MeController {
  constructor(private readonly auth: AuthService, @Inject(DB) private readonly db: Db) {}

  @Get()
  async me(@CurrentUser() user: AuthenticatedUser) {
    // Re-read mustChangePassword from DB so the UI sees fresh state after a change.
    const [row] = await this.db
      .select({ mustChangePassword: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    return { ...user, mustChangePassword: row?.mustChangePassword ?? false };
  }

  @Post("change-password")
  @Audited({ action: "user.changePassword", resourceType: "user" })
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const { newPassword } = changePasswordBody.parse(body);
    if (newPassword === "admin") {
      throw new BadRequestException("Choose a password other than the default");
    }
    const hash = await this.auth.hashPassword(newPassword);
    await this.db
      .insert(credentials)
      .values({ userId: user.id, passwordHash: hash })
      .onConflictDoUpdate({
        target: credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
    await this.db
      .update(users)
      .set({ mustChangePassword: false, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return { ok: true };
  }
}
