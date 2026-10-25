import { Body, Controller, Delete, Get, Param, Post, Put, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS, createUnifiVouchersSchema, setSwitchViewSchema } from "@church/shared";
import { OperationalOnly } from "../auth/operational-only.decorator";
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

  /** Which device profile draws this device's picture (auto / a profile / none). Display only: nothing reaches the controller. */
  @Put("devices/:mac/switch-view")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "unifi.device.view", resourceType: "unifi_device", resourceIdFromParams: (p) => p.mac ?? null })
  setDeviceView(@Param("mac") mac: string, @Body() body: unknown) {
    const parsed = setSwitchViewSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.unifi.setDeviceView(mac, parsed.data);
  }

  /** UniFi Protect cameras (read-only), while `unifi.protect_enabled` is on. */
  @Get("cameras")
  cameras() {
    return this.unifi.cameras();
  }

  /**
   * Guest Wi-Fi vouchers. A code is a way onto the guest network, so listing them needs the monitoring admin tier too, like
   * making and revoking them. Creating and revoking change the controller: operational for API tokens, not offered to MCP
   * (a person hands vouchers out, printed from the web app).
   */
  @Get("vouchers")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  vouchers() {
    return this.unifi.vouchers();
  }

  @Post("vouchers")
  @OperationalOnly()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "unifi.voucher.create", resourceType: "unifi_voucher" })
  createVouchers(@Body() body: unknown) {
    const parsed = createUnifiVouchersSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.unifi.createVouchers(parsed.data);
  }

  @Delete("vouchers/:id")
  @OperationalOnly()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "unifi.voucher.revoke", resourceType: "unifi_voucher", resourceIdFromParams: (p) => p.id ?? null })
  async revokeVoucher(@Param("id") id: string) {
    if (!/^[0-9a-f]{24}$/i.test(id)) throw new BadRequestException("Not a voucher id");
    await this.unifi.revokeVoucher(id);
    return { ok: true };
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
