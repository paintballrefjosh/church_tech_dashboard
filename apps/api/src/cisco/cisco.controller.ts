import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Query,
  BadGatewayException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import {
  PERMISSIONS,
  createCiscoSwitchSchema,
  updateCiscoSwitchSchema,
  ciscoPortInputSchema,
  ciscoVlanSetSchema,
  updateCiscoPortSchema,
} from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { OperationalOnly } from "../auth/operational-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { CiscoService } from "./cisco.service";
import { CiscoPoller } from "./cisco.poller";
import { CiscoVlansService } from "./cisco-vlans.service";
import { VLAN_FIELD_EXISTS, parseVlanScope } from "./vlan-drift";
import type { PushChange } from "./push-commands";

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
  private readonly logger = new Logger(CiscoController.name);

  constructor(
    private readonly cisco: CiscoService,
    private readonly poller: CiscoPoller,
    private readonly vlans: CiscoVlansService,
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

  @Post("switches/:id/reset-host-key")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.reset_host_key", resourceType: "cisco_switch", resourceIdFromParams: (p) => p.id ?? null })
  async resetHostKey(@Param("id") id: string) {
    const result = await this.cisco.resetHostKey(id);
    // Record the key the switch presents now rather than waiting for the next scheduled poll.
    void this.poller.pollSwitchById(id).catch(() => undefined);
    return result;
  }

  @Delete("switches/:id")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.delete", resourceType: "cisco_switch" })
  deleteSwitch(@Param("id") id: string) {
    return this.cisco.remove(id);
  }

  @Post("switches/:id/poll")
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.poll", resourceType: "cisco_switch" })
  poll(@Param("id") id: string) {
    void this.poller.pollSwitchById(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  @Post("switches/:id/discover")
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.switch.discover", resourceType: "cisco_switch" })
  discover(@Param("id") id: string) {
    // Force a fresh baseline (clears desired ports + open drift, then re-seeds).
    void this.poller.reimportPorts(id).catch(() => undefined);
    return { ok: true, started: true };
  }

  @Post("switches/:id/collect-l2")
  @OperationalOnly()
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

  // The Monitoring user tier (every volunteer, by default) may read these, so secrets in the text are hidden unless the
  // caller can change the switches (see config-redact.ts).
  @Get("switches/:id/backups/:backupId")
  @RequirePermissions(READ)
  backup(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Param("backupId") backupId: string) {
    return this.cisco.backup(id, backupId, !user.permissions.includes(WRITE));
  }

  @Get("switches/:id/backups/:aId/diff/:bId")
  @RequirePermissions(READ)
  backupDiff(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Param("aId") aId: string, @Param("bId") bId: string) {
    return this.cisco.backupDiff(id, aId, bId, !user.permissions.includes(WRITE));
  }

  @Delete("switches/:id/backups/:backupId")
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.backup.delete", resourceType: "cisco_switch" })
  deleteBackup(@Param("id") id: string, @Param("backupId") backupId: string) {
    return this.cisco.deleteBackup(id, backupId);
  }

  @Post("switches/:id/backups/trigger-full")
  @OperationalOnly()
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
  @OperationalOnly()
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
  @OperationalOnly()
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
      const names = await this.vlans.desiredNames(id);
      const changes: PushChange[] = open.map((d) => {
        const vlanId = parseVlanScope(d.portId);
        return {
          portId: d.portId,
          field: d.field,
          value: d.expected,
          ...(vlanId !== null && d.field === VLAN_FIELD_EXISTS ? { name: names.get(vlanId) } : {}),
        };
      });
      // A VLAN is only taken off the switch when nothing there uses it, whatever the wanted list says.
      for (const c of changes) {
        const vlanId = parseVlanScope(c.portId);
        if (vlanId !== null && c.field === VLAN_FIELD_EXISTS && c.value === "0") await this.vlans.assertDeletable(id, vlanId);
      }
      try {
        await this.poller.pushToSwitch(id, changes);
      } catch (err) {
        // The message says what went wrong (refused command, no connection, another push still running); a bare 500 would not.
        throw new BadGatewayException(`Could not push to the switch: ${(err as Error).message}`);
      }
      await this.vlans.applyPushed(id, changes);
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
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.create", resourceType: "cisco_switch" })
  async createPort(@Param("id") id: string, @Body() body: unknown) {
    const parsed = ciscoPortInputSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.cisco.createPort(id, parsed.data);
  }

  @Patch("switches/:id/ports/:portRowId")
  @OperationalOnly()
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
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.port.toggle", resourceType: "cisco_switch" })
  async togglePort(@Param("id") id: string, @Param("portRowId") portRowId: string, @Body() body: unknown) {
    const enabled = Boolean((body as { enabled?: boolean })?.enabled);
    const row = await this.cisco.updatePort(id, portRowId, { adminEnabled: enabled });
    void this.poller
      .pushToSwitch(id, [{ portId: row.portId, field: "admin_enabled", value: enabled ? "1" : "0" }])
      .catch((err: unknown) => this.logger.warn(`port ${row.portId} toggle was not pushed to switch ${id}: ${(err as Error).message}`));
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

  // ---- VLANs (layer 2) ----
  @Get("vlans")
  @RequirePermissions(READ)
  vlanList() {
    return this.vlans.fleetView();
  }

  @Get("switches/:id/vlans")
  @RequirePermissions(READ)
  switchVlans(@Param("id") id: string) {
    return this.vlans.forSwitch(id);
  }

  /** Set one VLAN's name and which switches should have it (others lose it). Desired config only; a push sends it. */
  @Put("vlans/:vlanId")
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.vlan.set", resourceType: "cisco_vlan" })
  async setVlan(@Param("vlanId") vlanId: string, @Body() body: unknown) {
    const parsed = ciscoVlanSetSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.vlans.setVlan(this.vlanIdParam(vlanId), parsed.data.name, parsed.data.switchIds);
  }

  @Delete("vlans/:vlanId")
  @OperationalOnly()
  @RequirePermissions(WRITE)
  @Audited({ action: "cisco.vlan.delete", resourceType: "cisco_vlan" })
  removeVlan(@Param("vlanId") vlanId: string) {
    return this.vlans.removeVlan(this.vlanIdParam(vlanId));
  }

  private vlanIdParam(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 4094) throw new BadRequestException("VLAN id must be a whole number from 1 to 4094");
    return n;
  }
}
