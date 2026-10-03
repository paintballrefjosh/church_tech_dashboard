import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
import {
  PERMISSIONS,
  createMonitorSchema,
  updateMonitorSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SettingsService } from "../settings/settings.service";
import { MonitorsService } from "./monitors.service";

const MAINTENANCE_KEY = "monitoring.maintenance_mode";

@Controller("monitors")
export class MonitorsController {
  constructor(
    private readonly monitors: MonitorsService,
    private readonly settings: SettingsService,
  ) {}

  // Global maintenance-mode toggle. Declared before the `:id` routes so
  // "maintenance" isn't captured as a monitor id. Silences alert notifications
  // across infra / services / UniFi; incidents are still recorded.
  @Get("maintenance")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  async getMaintenance() {
    return { enabled: (await this.settings.get(MAINTENANCE_KEY)) === true };
  }

  @Post("maintenance")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "monitor.maintenance", resourceType: "setting" })
  async setMaintenance(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser | null) {
    const enabled = Boolean((body as { enabled?: unknown })?.enabled);
    await this.settings.set(MAINTENANCE_KEY, enabled, user?.id ?? null);
    return { enabled };
  }

  @Get()
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  list() {
    return this.monitors.list();
  }

  @Get("summary")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  summary() {
    return this.monitors.summary();
  }

  @Get("incidents/open")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  openIncidents() {
    return this.monitors.openIncidents();
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.monitors.getById(id);
  }

  @Get(":id/history")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  history(@Param("id") id: string, @Query("limit") limit?: string) {
    const n = Math.max(1, Math.min(500, parseInt(limit ?? "100", 10) || 100));
    return this.monitors.history(id, n);
  }

  @Get(":id/incidents")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  incidents(@Param("id") id: string) {
    return this.monitors.incidents(id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "monitor.create", resourceType: "monitor" })
  async create(@Body() body: unknown) {
    const parsed = createMonitorSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.monitors.create(parsed.data);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "monitor.update",
    resourceType: "monitor",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateMonitorSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.monitors.update(id, parsed.data);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "monitor.delete",
    resourceType: "monitor",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.monitors.delete(id);
  }
}
