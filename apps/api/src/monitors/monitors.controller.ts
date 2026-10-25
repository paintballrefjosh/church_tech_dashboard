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
import { z } from "zod";
import {
  MAINTENANCE_MAX_MINUTES,
  MAINTENANCE_MODE_KEY,
  MAINTENANCE_UNTIL_KEY,
  PERMISSIONS,
  createMonitorSchema,
  updateMonitorSchema,
  type MaintenanceState,
  redactMonitorOptions,
  monitorScheduleProblem,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SettingsService } from "../settings/settings.service";
import { MonitorsService } from "./monitors.service";
import { readMaintenance } from "./maintenance";

const maintenanceBody = z.object({
  enabled: z.boolean(),
  /** How long to stay in maintenance; left out = until switched off by hand. */
  minutes: z.number().int().min(1).max(MAINTENANCE_MAX_MINUTES).optional(),
});

/** `enabled`: alerts are silenced now. `until`: ISO end time, or null when it has none. */
function maintenanceReply(state: MaintenanceState): { enabled: boolean; until: string | null } {
  return { enabled: state.active, until: state.active && state.until !== null ? new Date(state.until).toISOString() : null };
}

/** What the schemas cannot say: a schedule that reads, and a livestream given as a web address. */
function checkMonitorInput(kind: string | undefined, target: string | undefined, options: Record<string, unknown> | undefined): void {
  const problem = monitorScheduleProblem(options?.schedule);
  if (problem) throw new BadRequestException(`Schedule: ${problem}`);
  if (kind === "hls" && target !== undefined && !/^https?:\/\//i.test(target)) {
    throw new BadRequestException("A livestream (HLS) monitor needs the playlist's address, starting http:// or https://");
  }
}

/** A monitor as the API returns it: credentials in its options replaced by a placeholder (see MONITOR_SECRET_OPTION_KEYS). */
function redacted<T extends { options: unknown }>(m: T): T {
  return { ...m, options: redactMonitorOptions(m.options as Record<string, unknown>) };
}

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
    return maintenanceReply(await readMaintenance(this.settings));
  }

  @Post("maintenance")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "monitor.maintenance", resourceType: "setting" })
  async setMaintenance(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser | null) {
    const parsed = maintenanceBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const { enabled, minutes } = parsed.data;
    const by = user?.id ?? null;
    if (enabled) {
      // End time first: the switch is not on yet, so nothing is silenced by a half-written pair.
      await this.settings.set(MAINTENANCE_UNTIL_KEY, minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : "", by);
      await this.settings.set(MAINTENANCE_MODE_KEY, true, by);
    } else {
      await this.settings.set(MAINTENANCE_MODE_KEY, false, by);
      await this.settings.set(MAINTENANCE_UNTIL_KEY, "", by);
    }
    return maintenanceReply(await readMaintenance(this.settings));
  }

  @Get()
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  async list() {
    return (await this.monitors.list()).map(redacted);
  }

  @Get("summary")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  summary() {
    return this.monitors.summary();
  }

  // Per-node probe worker figures for a multi-node deployment (declared before `:id`).
  @Get("workers")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  workers() {
    return this.monitors.workers();
  }

  @Get("incidents/open")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  openIncidents() {
    return this.monitors.openIncidents();
  }

  @Post("incidents/:incidentId/ack")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "monitor.incident.acknowledge",
    resourceType: "monitor_incident",
    resourceIdFromParams: (p) => p.incidentId ?? null,
  })
  acknowledge(@Param("incidentId") incidentId: string, @CurrentUser() user: AuthenticatedUser | null) {
    if (!/^[0-9a-f-]{36}$/i.test(incidentId)) throw new BadRequestException("Not an incident id");
    return this.monitors.acknowledgeIncident(incidentId, user?.id ?? null);
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  async byId(@Param("id") id: string) {
    return redacted(await this.monitors.getById(id));
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
    checkMonitorInput(parsed.data.kind, parsed.data.target, parsed.data.options);
    return redacted(await this.monitors.create(parsed.data));
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
    checkMonitorInput(parsed.data.kind, parsed.data.target, parsed.data.options);
    return redacted(await this.monitors.update(id, parsed.data));
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "monitor.delete",
    resourceType: "monitor",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async remove(@Param("id") id: string) {
    const row = await this.monitors.delete(id);
    return row ? redacted(row) : row;
  }
}
