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
  createInfraTargetSchema,
  updateInfraTargetSchema,
  createInfraUpdateRunSchema,
  type InfraEntityKind,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { InfraService } from "./infra.service";
import { InfraTester } from "./infra-tester";
import { InfraUpdaterService } from "./infra-updater";
import { InfraCollector } from "./infra-collector";

@Controller("infra")
export class InfraController {
  constructor(
    private readonly infra: InfraService,
    private readonly tester: InfraTester,
    private readonly updater: InfraUpdaterService,
    private readonly collector: InfraCollector,
  ) {}

  @Get("summary")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  summary() {
    return this.infra.summary();
  }

  @Get("incidents/open")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  openIncidents() {
    return this.infra.openIncidents();
  }

  @Get("targets")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  list() {
    return this.infra.list();
  }

  @Get("targets/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  byId(@Param("id") id: string) {
    return this.infra.getById(id);
  }

  @Get("targets/:id/entities")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  entities(@Param("id") id: string, @Query("kind") kind?: string) {
    return this.infra.entities(id, kind as InfraEntityKind | undefined);
  }

  @Get("targets/:id/metrics")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  metrics(
    @Param("id") id: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("entityKind") entityKind?: string,
    @Query("entityId") entityId?: string,
  ) {
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 3_600_000);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException("Invalid from/to");
    }
    return this.infra.series(id, {
      from: fromDate,
      to: toDate,
      entityKind: entityKind as InfraEntityKind | undefined,
      entityId,
    });
  }

  @Get("targets/:id/incidents")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  incidents(@Param("id") id: string) {
    return this.infra.incidentsFor(id);
  }

  /**
   * Manual "check now" — runs the same collection a scheduled tick would
   * (cpu/mem/disk/load, and OS updates if that capability is on), bypassing
   * the target's interval-due check, and returns the refreshed target so the
   * detail page can update without waiting on its own next poll/realtime tick.
   */
  @Post("targets/:id/poll-now")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "infra.target.poll_now",
    resourceType: "infra_target",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async pollNow(@Param("id") id: string) {
    await this.collector.pollNow(id);
    return this.infra.getById(id);
  }

  /**
   * On-demand service inventory for the target's Services card "discover"
   * picker — a live SSH probe, separate from the regular poll cycle so the
   * regular poll doesn't pay for a full unit listing every tick.
   */
  @Post("targets/:id/discover-services")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "infra.target.discover_services",
    resourceType: "infra_target",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async discoverServices(@Param("id") id: string) {
    return this.collector.discoverServices(id);
  }

  @Post("targets")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({ action: "infra.target.create", resourceType: "infra_target" })
  async create(@Body() body: unknown) {
    const parsed = createInfraTargetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.infra.create(parsed.data);
  }

  @Patch("targets/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "infra.target.update",
    resourceType: "infra_target",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async update(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateInfraTargetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.infra.update(id, parsed.data);
  }

  @Delete("targets/:id")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "infra.target.delete",
    resourceType: "infra_target",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  remove(@Param("id") id: string) {
    return this.infra.delete(id);
  }

  @Get("targets/:id/update-runs")
  @RequirePermissions(PERMISSIONS.MONITORS_READ_ANY)
  updateRuns(@Param("id") id: string) {
    return this.updater.listRuns(id);
  }

  /**
   * Triggers a package-manager upgrade over SSH; runs in the background
   * (see InfraUpdaterService) so this returns as soon as the run is
   * recorded, not once the upgrade finishes. Same admin-tier permission as
   * every other target mutation — this is at least as consequential as
   * editing or deleting a target.
   */
  @Post("targets/:id/update-run")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  @Audited({
    action: "infra.target.update_run.start",
    resourceType: "infra_target",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async startUpdateRun(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = createInfraUpdateRunSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.updater.start(id, user, parsed.data.reboot, parsed.data.fullUpgrade, parsed.data.includePhased);
  }

  /**
   * Ad-hoc connectivity test for the Add/Edit dialog. Runs a single bounded
   * probe against the (possibly unsaved) connection details in the body.
   */
  @Post("targets/test")
  @RequirePermissions(PERMISSIONS.MONITORS_WRITE_ANY)
  async test(@Body() body: unknown) {
    const parsed = createInfraTargetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tester.test(parsed.data);
  }
}
