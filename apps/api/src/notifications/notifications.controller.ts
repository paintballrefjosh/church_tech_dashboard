import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  BadRequestException,
} from "@nestjs/common";
import { notificationListQuerySchema } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { NotificationsService } from "./notifications.service";
import { SkipAudit } from "../audit/audit.decorator";

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const parsed = notificationListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.notifications.list(user.id, parsed.data);
  }

  @Get("unread-count")
  async unreadCount(@CurrentUser() user: AuthenticatedUser) {
    return { count: await this.notifications.unreadCount(user.id) };
  }

  // The "read"/"dismiss" endpoints fire on every notification click — auditing
  // them would flood audit_log without surfacing anything actionable.
  @Post(":id/read")
  @SkipAudit()
  async markRead(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.notifications.markRead(user.id, id);
    return { ok: true };
  }

  @Post("read-all")
  @SkipAudit()
  async markAllRead(@CurrentUser() user: AuthenticatedUser) {
    await this.notifications.markAllRead(user.id);
    return { ok: true };
  }

  @Delete(":id")
  @SkipAudit()
  async dismiss(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.notifications.dismiss(user.id, id);
    return { ok: true };
  }

  /**
   * Body: { to?: string } — sends a one-line test message to the caller, or
   * to the email supplied. Useful from /admin/settings to validate SMTP is
   * wired correctly. Anyone signed in can test against themselves; aiming at
   * a different recipient is gated to admin role.
   */
  @Post("test-email")
  async testEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    const to = (body && typeof body === "object" && "to" in body && typeof (body as { to?: unknown }).to === "string")
      ? (body as { to: string }).to
      : user.email;
    // Self-test always allowed; only admin can mail another address.
    if (to !== user.email && !user.permissions.includes("settings:write:any")) {
      throw new BadRequestException("Only admins can test-mail another address");
    }
    await this.notifications.create({
      recipientUserId: user.id,
      kind: "system.test",
      title: "Church Dashboard SMTP test",
      body: `If you're reading this email, SMTP is wired up. Sent to ${to}.`,
      link: null,
    });
    return { ok: true, sentTo: to };
  }
}
