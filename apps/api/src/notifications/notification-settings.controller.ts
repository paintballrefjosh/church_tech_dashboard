import { BadRequestException, Body, Controller, Delete, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import { describeUserAgent, notificationDeliverySchema, pushSubscribeSchema } from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { PushService } from "./push.service";

/**
 * A person's own delivery choices: quiet hours and the daily summary, and the browsers they turned push on in.
 * Push routes are session-only: a subscription sends this person's notices to a browser, so a leaked API token must not be
 * able to add one (or read the list of devices).
 */
@Controller("me")
export class NotificationSettingsController {
  constructor(
    private readonly delivery: NotificationDeliveryService,
    private readonly push: PushService,
  ) {}

  @Get("notification-delivery")
  async getDelivery(@CurrentUser() user: AuthenticatedUser) {
    const [value, timeZone] = await Promise.all([this.delivery.get(user.id), this.delivery.zone()]);
    return { ...value, timeZone };
  }

  @Put("notification-delivery")
  @Audited({ action: "user.notificationDelivery.update", resourceType: "user" })
  async setDelivery(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = notificationDeliverySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const value = await this.delivery.set(user.id, parsed.data);
    return { ...value, timeZone: await this.delivery.zone() };
  }

  @Get("push")
  @SessionOnly()
  async pushStatus(@CurrentUser() user: AuthenticatedUser) {
    const enabled = await this.push.enabled();
    const devices = enabled ? await this.push.list(user.id) : [];
    return {
      enabled,
      publicKey: enabled ? this.push.publicKey() : null,
      devices: devices.map((d) => ({
        id: d.id,
        fingerprint: d.fingerprint,
        label: describeUserAgent(d.userAgent).label,
        createdAt: d.createdAt,
        lastSentAt: d.lastSentAt,
        lastError: d.lastError,
      })),
    };
  }

  @Post("push/subscriptions")
  @SessionOnly()
  @Audited({ action: "user.push.subscribe", resourceType: "user" })
  async subscribe(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown, @Headers("user-agent") userAgent: string | undefined) {
    if (!(await this.push.enabled())) throw new BadRequestException("Push notifications are switched off for this site.");
    const parsed = pushSubscribeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.push.subscribe(user.id, parsed.data, userAgent ?? "");
  }

  @Delete("push/subscriptions/:id")
  @SessionOnly()
  @Audited({ action: "user.push.unsubscribe", resourceType: "user" })
  async unsubscribe(@CurrentUser() user: AuthenticatedUser, @Param("id", ParseUUIDPipe) id: string) {
    if (!(await this.push.remove(user.id, id))) throw new NotFoundException("Device not found");
    return { ok: true };
  }

  /** Send the caller a push, to check it works. Tells how many devices took it. */
  @Post("push/test")
  @SessionOnly()
  async test(@CurrentUser() user: AuthenticatedUser) {
    if (!(await this.push.enabled())) throw new BadRequestException("Push notifications are switched off for this site.");
    return this.push.sendTest(user.id);
  }
}
