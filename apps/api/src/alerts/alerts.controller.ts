import { BadRequestException, Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { PERMISSIONS, createAlertChannelSchema, updateAlertChannelSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { AlertChannelsService } from "./alert-channels.service";

/**
 * Alert channels. Reading them shows phone numbers, topics and which services alerts go to, so reads need the monitoring
 * admin tier like the writes (the secret itself is never returned, only `hasSecret`). Not offered to MCP agents: a channel
 * holds a token or a webhook address (route-rules.ts).
 */
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

@Controller("alert-channels")
export class AlertsController {
  constructor(private readonly channels: AlertChannelsService) {}

  @Get()
  @RequirePermissions(WRITE)
  list() {
    return this.channels.list();
  }

  @Post()
  @RequirePermissions(WRITE)
  @Audited({ action: "alert_channel.create", resourceType: "alert_channel", redactKeys: ["secret"] })
  create(@Body() body: unknown) {
    return this.channels.create(parse(createAlertChannelSchema, body));
  }

  @Get(":id")
  @RequirePermissions(WRITE)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.channels.get(id);
  }

  @Patch(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "alert_channel.update", resourceType: "alert_channel", resourceIdFromParams: (p) => p.id ?? null, redactKeys: ["secret"] })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.channels.update(id, parse(updateAlertChannelSchema, body));
  }

  @Delete(":id")
  @RequirePermissions(WRITE)
  @Audited({ action: "alert_channel.delete", resourceType: "alert_channel", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.channels.remove(id);
    return { ok: true };
  }

  /** Send a test message now (even to a switched-off channel). Answers the channel with its updated last result. */
  @Post(":id/test")
  @RequirePermissions(WRITE)
  @Audited({ action: "alert_channel.test", resourceType: "alert_channel", resourceIdFromParams: (p) => p.id ?? null })
  test(@Param("id", ParseUUIDPipe) id: string) {
    return this.channels.test(id);
  }
}
