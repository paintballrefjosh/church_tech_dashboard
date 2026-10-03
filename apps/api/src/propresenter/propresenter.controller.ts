import { Body, Controller, Get, Post, BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { PERMISSIONS } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { PropresenterService } from "./propresenter.service";

const testBodySchema = z.object({
  host: z.string().max(255).optional(),
  port: z.union([z.number().int().min(1).max(65535), z.string()]).optional(),
  password: z.string().max(256).optional(),
});

@Controller("propresenter")
export class PropresenterController {
  constructor(private readonly pp: PropresenterService) {}

  @Get("health")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_READ_ANY)
  health() {
    return this.pp.health();
  }

  @Get("status")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_READ_ANY)
  status() {
    return this.pp.status();
  }

  @Post("next")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_ADMIN)
  @Audited({ action: "propresenter.next", resourceType: "propresenter" })
  next() {
    return this.pp.next();
  }

  @Post("previous")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_ADMIN)
  @Audited({ action: "propresenter.previous", resourceType: "propresenter" })
  previous() {
    return this.pp.previous();
  }

  @Post("clear")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_ADMIN)
  @Audited({ action: "propresenter.clear", resourceType: "propresenter" })
  clear() {
    return this.pp.clearAll();
  }

  /**
   * Admin "Test connection" button on the ProPresenter settings page. Accepts
   * an optional override of host/port/password so the operator can verify
   * unsaved form values; anything missing falls back to the stored config.
   */
  @Post("test")
  @RequirePermissions(PERMISSIONS.PROPRESENTER_ADMIN)
  test(@Body() body: unknown) {
    const parsed = testBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const rawPort = parsed.data.port;
    const port =
      typeof rawPort === "number"
        ? rawPort
        : typeof rawPort === "string" && rawPort.trim() !== ""
          ? parseInt(rawPort, 10)
          : undefined;
    return this.pp.testConnection({
      host: parsed.data.host,
      port: typeof port === "number" && Number.isFinite(port) ? port : undefined,
      password: parsed.data.password,
    });
  }
}
