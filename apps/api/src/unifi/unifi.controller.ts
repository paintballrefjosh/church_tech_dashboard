import { Body, Controller, Delete, Get, Param, Post, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { UnifiService } from "./unifi.service";

const testBodySchema = z.object({
  baseUrl: z.string().max(2048).optional(),
  apiKey: z.string().max(512).optional(),
  siteId: z.string().max(128).optional(),
  verifyTls: z.boolean().optional(),
});

@Controller("unifi")
@RequirePermissions(PERMISSIONS.UNIFI_READ_ANY)
export class UnifiController {
  constructor(private readonly unifi: UnifiService) {}

  @Get("health")
  health() {
    return this.unifi.health();
  }

  @Get("summary")
  summary() {
    return this.unifi.summary();
  }

  @Get("devices")
  devices() {
    return this.unifi.devices();
  }

  @Get("clients")
  clients() {
    return this.unifi.clients();
  }

  /**
   * Acknowledge an offline device so it stops counting toward the Network tab
   * badge. The ack auto-clears when the device is next seen online, so a later
   * re-offline counts again. Gated on the monitoring write tier (merged with the
   * class-level UNIFI_READ_ANY).
   */
  @Post("devices/:mac/ack")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "unifi.device.ack", resourceType: "unifi_device", resourceIdFromParams: (p) => p.mac ?? null })
  ack(@Param("mac") mac: string, @CurrentUser() user: AuthenticatedUser) {
    return this.unifi.ackDevice(mac, user?.id ?? null);
  }

  @Delete("devices/:mac/ack")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "unifi.device.unack", resourceType: "unifi_device", resourceIdFromParams: (p) => p.mac ?? null })
  unack(@Param("mac") mac: string) {
    return this.unifi.unackDevice(mac);
  }

  /**
   * Admin "Test connection" button on the UniFi settings page. Accepts an
   * optional override of the controller URL / API key / site / verify-tls so
   * the operator can verify unsaved form values; anything missing falls back
   * to the stored config.
   */
  @Post("test")
  @RequirePermissions(PERMISSIONS.UNIFI_ADMIN)
  test(@Body() body: unknown) {
    const parsed = testBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.unifi.testConnection(parsed.data);
  }
}
