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
  createCiscoSwitchSchema,
  updateCiscoSwitchSchema,
  ciscoPortInputSchema,
  updateCiscoPortSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CiscoService } from "./cisco.service";
import { CiscoPoller } from "./cisco.poller";

/**
 * Cisco switch management API. Reads require the `monitoring` module at any
 * tier (monitors:read:any); every mutation requires the module admin tier
 * (monitors:write:any) — "network admin" in the merged monitoring module.
 *
 * Long-running SSH work (poll / discover / manual backup) is kicked off in the
 * background so the HTTP request returns immediately; the UI re-fetches.
 */
const READ = PERMISSIONS.MONITORS_READ_ANY;
const WRITE = PERMISSIONS.MONITORS_WRITE_ANY;

@Controller("cisco")
export class CiscoController {
  constructor(
    private readonly cisco: CiscoService,
    private readonly poller: CiscoPoller,
  ) {}

  // ---- switches ----
  @Get("switches")
  @RequirePermissions(READ)
  listSwitches() {
    return this.cisco.list();
  }

  @Get("switches/:id")
  @RequirePermissions(READ)
  getSwitch(@Param("id") id: string) {
    return this.cisco.getById(id);
  }

  @Post("switches")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.create", resourceType: "cisco_switch" })
  async createSwitch(@Body() body: unknown) {
    const parsed = createCiscoSwitchSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const sw = await this.cisco.create(parsed.data);
    // Poll + import ports in the background (SSH can take a while).
    void this.poller.importPorts(sw.id).catch(() => undefined);
    return sw;
  }

  @Patch("switches/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.update", resourceType: "cisco_switch" })
  async updateSwitch(@Param("id") id: string, @Body() body: unknown) {
    const parsed = updateCiscoSwitchSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.cisco.update(id, parsed.data);
  }

  @Delete("switches/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.delete", resourceType: "cisco_switch" })
  deleteSwitch(@Param("id") id: string) {
    return this.cisco.remove(id);
  }

  @Post("switches/:id/poll")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.poll", resourceType: "cisco_switch" })
  poll(@Param("id") id: string) {
    void this.poller.pollSwitchById(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  @Post("switches/:id/discover")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.discover", resourceType: "cisco_switch" })
  discover(@Param("id") id: string) {
    // Force a fresh baseline (clears desired ports + open drift, then re-seeds).
    void this.poller.reimportPorts(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  @Post("switches/:id/collect-l2")
  @RequirePermissions(WRITE)
  collectL2(@Param("id") id: string) {
    void this.poller.pollSwitchById(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  // ---- backups ----
  @Get("switches/:id/backups")
  @RequirePermissions(READ)
  backups(@Param("id") id: string) {
    return this.cisco.backups(id);
  }

  @Get("backups/status")
  @RequirePermissions(READ)
  backupStatus() {
    return this.cisco.backupStatus();
  }

  @Get("switches/:id/backups/:backupId")
  @RequirePermissions(READ)
  backup(@Param("id") id: string, @Param("backupId") backupId: string) {
    return this.cisco.backup(id, backupId);
  }

  @Get("switches/:id/backups/:aId/diff/:bId")
  @RequirePermissions(READ)
  backupDiff(@Param("id") id: string, @Param("aId") aId: string, @Param("bId") bId: string) {
    return this.cisco.backupDiff(id, aId, bId);
  }

  @Delete("switches/:id/backups/:backupId")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.backup.delete", resourceType: "cisco_switch" })
  deleteBackup(@Param("id") id: string, @Param("backupId") backupId: string) {
    return this.cisco.deleteBackup(id, backupId);
  }

  @Post("switches/:id/backups/trigger-full")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.backup.trigger", resourceType: "cisco_switch" })
  triggerFull(@Param("id") id: string) {
    void this.poller.triggerManualBackup(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  // ---- drift ----
  @Get("switches/:id/drift")
  @RequirePermissions(READ)
  drift(@Param("id") id: string) {
    return this.cisco.drift(id);
  }

  @Post("switches/:id/drift/resolve")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.drift.resolve", resourceType: "cisco_switch" })
  resolveDrift(@Param("id") id: string) {
    return this.cisco.resolveAllDrift(id);
  }

  @Post("switches/:id/drift/push-all")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.drift.push", resourceType: "cisco_switch" })
  pushAll(@Param("id") id: string) {
    return this.pushDrift(id);
  }

  @Post("switches/:id/drift/accept-all")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.drift.accept", resourceType: "cisco_switch" })
  acceptAll(@Param("id") id: string) {
    return this.cisco.acceptDrift(id);
  }

  @Post("switches/:id/drift/:driftId/push")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.drift.push", resourceType: "cisco_switch" })
  pushOne(@Param("id") id: string, @Param("driftId") driftId: string) {
    return this.pushDrift(id, driftId);
  }

  @Post("switches/:id/drift/:driftId/accept")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.drift.accept", resourceType: "cisco_switch" })
  acceptOne(@Param("id") id: string, @Param("driftId") driftId: string) {
    return this.cisco.acceptDrift(id, driftId);
  }

  /** Push the expected (desired) value(s) to the device, then resolve. */
  private async pushDrift(id: string, driftId?: string): Promise<{ ok: true; count: number }> {
    const open = await this.cisco.openDrift(id, driftId);
    if (open.length) {
      await this.poller.pushToSwitch(
        id,
        open.map((d) => ({ portId: d.portId, field: d.field, value: d.expected })),
      );
      await this.cisco.markResolved(open.map((d) => d.id));
      await this.cisco.recomputeDrift(id);
    }
    return { ok: true, count: open.length };
  }

  // ---- ports (desired config editing) ----
  @Get("switches/:id/ports")
  @RequirePermissions(READ)
  ports(@Param("id") id: string) {
    return this.cisco.portsForSwitch(id);
  }

  @Post("switches/:id/ports")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.create", resourceType: "cisco_switch" })
  async createPort(@Param("id") id: string, @Body() body: unknown) {
    const parsed = ciscoPortInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.cisco.createPort(id, parsed.data);
  }

  @Patch("switches/:id/ports/:portRowId")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.update", resourceType: "cisco_switch" })
  async updatePort(@Param("id") id: string, @Param("portRowId") portRowId: string, @Body() body: unknown) {
    const parsed = updateCiscoPortSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.cisco.updatePort(id, portRowId, parsed.data);
  }

  @Delete("switches/:id/ports/:portRowId")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.delete", resourceType: "cisco_switch" })
  deletePort(@Param("id") id: string, @Param("portRowId") portRowId: string) {
    return this.cisco.deletePort(id, portRowId);
  }

  /** Toggle a port's admin state in the desired config AND push it to the device. */
  @Post("switches/:id/ports/:portRowId/toggle")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.toggle", resourceType: "cisco_switch" })
  async togglePort(@Param("id") id: string, @Param("portRowId") portRowId: string, @Body() body: unknown) {
    const enabled = Boolean((body as { enabled?: boolean })?.enabled);
    const row = await this.cisco.updatePort(id, portRowId, { adminEnabled: enabled });
    void this.poller
      .pushToSwitch(id, [{ portId: row.portId, field: "admin_enabled", value: enabled ? "1" : "0" }])
      .catch(() => undefined);
    return { ok: true, started: true };
  }

  // ---- fleet-wide backups + drift + topology ----
  @Get("backups")
  @RequirePermissions(READ)
  allBackups(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("sort") sort?: string,
    @Query("dir") dir?: string,
  ) {
    const lim = Math.min(500, Math.max(1, parseInt(limit ?? "50", 10) || 50));
    const off = Math.max(0, parseInt(offset ?? "0", 10) || 0);
    const term = (q ?? "").trim();
    return this.cisco.allBackups({
      q: term.length ? term : null,
      limit: lim,
      offset: off,
      sort: sort ?? "at",
      dir: dir === "asc" ? "asc" : "desc",
    });
  }

  @Get("drift")
  @RequirePermissions(READ)
  allDrift(
    @Query("q") q?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("sort") sort?: string,
    @Query("dir") dir?: string,
  ) {
    const lim = Math.min(500, Math.max(1, parseInt(limit ?? "50", 10) || 50));
    const off = Math.max(0, parseInt(offset ?? "0", 10) || 0);
    const term = (q ?? "").trim();
    return this.cisco.allOpenDrift({
      q: term.length ? term : null,
      limit: lim,
      offset: off,
      sort: sort ?? "detected",
      dir: dir === "asc" ? "asc" : "desc",
    });
  }

  @Get("topology")
  @RequirePermissions(READ)
  topology() {
    return this.cisco.topology();
  }

  // ---- MAC / ARP lookup ----
  @Get("lookup")
  @RequirePermissions(READ)
  lookup(@Query("q") q?: string, @Query("exclude_uplinks") excludeUplinks?: string) {
    const term = (q ?? "").trim();
    if (term.length < 2) throw new BadRequestException("query must be at least 2 characters");
    return this.cisco.lookup(term, excludeUplinks !== "0");
  }

  /** Server-paginated fleet MAC/IP table (search + sort + page all server-side). */
  @Get("mac")
  @RequirePermissions(READ)
  allMac(
    @Query("q") q?: string,
    @Query("exclude_uplinks") excludeUplinks?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("sort") sort?: string,
    @Query("dir") dir?: string,
  ) {
    const lim = Math.min(500, Math.max(1, parseInt(limit ?? "50", 10) || 50));
    const off = Math.max(0, parseInt(offset ?? "0", 10) || 0);
    const term = (q ?? "").trim();
    return this.cisco.macTable({
      q: term.length ? term : null,
      excludeUplinks: excludeUplinks === "1",
      limit: lim,
      offset: off,
      sort: sort ?? "mac",
      dir: dir === "desc" ? "desc" : "asc",
    });
  }

  @Get("switches/:id/mac")
  @RequirePermissions(READ)
  mac(@Param("id") id: string) {
    return this.cisco.macForSwitch(id);
  }

  // ---- VLAN database ----
  @Get("vlans")
  @RequirePermissions(READ)
  vlans() {
    return this.cisco.vlans();
  }
}
