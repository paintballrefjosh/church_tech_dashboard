import { Injectable, Inject, NotFoundException, ConflictException } from "@nestjs/common";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  ciscoSwitches,
  ciscoPorts,
  ciscoPortLiveState,
  ciscoDriftEvents,
  ciscoConfigBackups,
  ciscoMacTable,
  ciscoArpCache,
  ciscoVlanDb,
  ciscoNeighbors,
} from "../db/schema";
import { encryptSecret } from "../settings/crypto";
import type {
  CiscoSwitch,
  CreateCiscoSwitchInput,
  UpdateCiscoSwitchInput,
  CiscoBackupListItem,
  CiscoBackupRow,
  CiscoDriftEvent,
  CiscoDriftRow,
  CiscoLookupRow,
  CiscoArpOnlyRow,
  CiscoVlanRow,
  CiscoPortRow,
  CiscoPortInput,
  UpdateCiscoPortInput,
  CiscoTopology,
  CiscoTopologyNode,
  CiscoTopologyEdge,
  CiscoAlertPrefs,
} from "@church/shared";
import { diffConfigs, type DiffResult } from "./diff";

type SwitchRow = typeof ciscoSwitches.$inferSelect;

/** Fields "accept observed" may write back into the desired `cisco_ports` row. */
const ACCEPTABLE_PORT_FIELDS = new Set([
  "admin_enabled",
  "speed",
  "duplex",
  "mode",
  "access_vlan",
  "trunk_native_vlan",
  "trunk_allowed_vlans",
  "description",
]);

@Injectable()
export class CiscoService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- switch CRUD ----

  async list(): Promise<CiscoSwitch[]> {
    const rows = await this.db.select().from(ciscoSwitches).orderBy(asc(ciscoSwitches.hostname));
    const [portCounts, upCounts, downEnabled] = await Promise.all([
      this.db
        .select({ switchId: ciscoPorts.switchId, n: sql<number>`count(*)::int` })
        .from(ciscoPorts)
        .groupBy(ciscoPorts.switchId),
      this.db
        .select({ switchId: ciscoPortLiveState.switchId, n: sql<number>`count(*)::int` })
        .from(ciscoPortLiveState)
        .where(eq(ciscoPortLiveState.operStatus, "up"))
        .groupBy(ciscoPortLiveState.switchId),
      // Desired-enabled ports that are operationally not up = real problems.
      this.db
        .select({ switchId: ciscoPorts.switchId, n: sql<number>`count(*)::int` })
        .from(ciscoPorts)
        .innerJoin(
          ciscoPortLiveState,
          and(
            eq(ciscoPortLiveState.switchId, ciscoPorts.switchId),
            eq(ciscoPortLiveState.portId, ciscoPorts.portId),
          ),
        )
        .where(and(eq(ciscoPorts.adminEnabled, true), sql`${ciscoPortLiveState.operStatus} <> 'up'`))
        .groupBy(ciscoPorts.switchId),
    ]);
    const pc = new Map(portCounts.map((r) => [r.switchId, Number(r.n)]));
    const uc = new Map(upCounts.map((r) => [r.switchId, Number(r.n)]));
    const dc = new Map(downEnabled.map((r) => [r.switchId, Number(r.n)]));
    return rows.map((r) => ({
      ...toSwitch(r),
      portCount: pc.get(r.id) ?? 0,
      portsUp: uc.get(r.id) ?? 0,
      portsDownEnabled: dc.get(r.id) ?? 0,
    }));
  }

  private async rowById(id: string): Promise<SwitchRow> {
    const [row] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, id)).limit(1);
    if (!row) throw new NotFoundException("Switch not found");
    return row;
  }

  async getById(id: string): Promise<CiscoSwitch> {
    return toSwitch(await this.rowById(id));
  }

  async create(input: CreateCiscoSwitchInput): Promise<CiscoSwitch> {
    const [dup] = await this.db
      .select({ id: ciscoSwitches.id })
      .from(ciscoSwitches)
      .where(eq(ciscoSwitches.hostname, input.hostname.trim()))
      .limit(1);
    if (dup) throw new ConflictException("A switch with that hostname already exists");
    const [row] = await this.db
      .insert(ciscoSwitches)
      .values({
        hostname: input.hostname.trim(),
        ipAddress: input.ipAddress.trim(),
        username: input.username.trim(),
        passwordEnc: encryptSecret(input.password),
        model: input.model?.trim() || null,
        location: input.location?.trim() || null,
        checkPortState: input.checkPortState ?? true,
        alertPrefs: normalizePrefs(input.alertPrefs),
      })
      .returning();
    if (!row) throw new Error("insert failed");
    return toSwitch(row);
  }

  async update(id: string, input: UpdateCiscoSwitchInput): Promise<CiscoSwitch> {
    const current = await this.rowById(id);
    const patch: Partial<typeof ciscoSwitches.$inferInsert> = { updatedAt: new Date() };
    if (input.alertPrefs !== undefined) {
      patch.alertPrefs = { ...normalizePrefs(current.alertPrefs), ...input.alertPrefs };
    }
    if (input.hostname !== undefined) patch.hostname = input.hostname.trim();
    if (input.ipAddress !== undefined) patch.ipAddress = input.ipAddress.trim();
    if (input.username !== undefined) patch.username = input.username.trim();
    if (input.model !== undefined) patch.model = input.model?.trim() || null;
    if (input.location !== undefined) patch.location = input.location?.trim() || null;
    if (input.checkPortState !== undefined) patch.checkPortState = input.checkPortState;
    // Blank/omitted password = keep the stored credential.
    if (input.password && input.password.length > 0) patch.passwordEnc = encryptSecret(input.password);
    await this.db.update(ciscoSwitches).set(patch).where(eq(ciscoSwitches.id, id));
    return this.getById(id);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const [row] = await this.db.delete(ciscoSwitches).where(eq(ciscoSwitches.id, id)).returning();
    if (!row) throw new NotFoundException("Switch not found");
    return { ok: true };
  }

  // ---- backups ----

  async backups(switchId: string): Promise<CiscoBackupListItem[]> {
    await this.rowById(switchId);
    const rows = await this.db
      .select({
        id: ciscoConfigBackups.id,
        backupType: ciscoConfigBackups.backupType,
        backedUpAt: ciscoConfigBackups.backedUpAt,
        checksum: ciscoConfigBackups.checksum,
        configSize: sql<number>`length(${ciscoConfigBackups.configText})::int`,
      })
      .from(ciscoConfigBackups)
      .where(eq(ciscoConfigBackups.switchId, switchId))
      .orderBy(desc(ciscoConfigBackups.backedUpAt));
    return rows.map((r) => ({
      id: r.id,
      backupType: r.backupType as CiscoBackupListItem["backupType"],
      backedUpAt: r.backedUpAt.toISOString(),
      checksum: r.checksum,
      configSize: Number(r.configSize),
    }));
  }

  async backup(switchId: string, backupId: string): Promise<{ id: string; configText: string; backedUpAt: string }> {
    const [row] = await this.db
      .select()
      .from(ciscoConfigBackups)
      .where(and(eq(ciscoConfigBackups.id, backupId), eq(ciscoConfigBackups.switchId, switchId)))
      .limit(1);
    if (!row) throw new NotFoundException("Backup not found");
    return { id: row.id, configText: row.configText, backedUpAt: row.backedUpAt.toISOString() };
  }

  async backupDiff(switchId: string, aId: string, bId: string): Promise<DiffResult> {
    const rows = await this.db
      .select({ id: ciscoConfigBackups.id, configText: ciscoConfigBackups.configText })
      .from(ciscoConfigBackups)
      .where(and(eq(ciscoConfigBackups.switchId, switchId), inArray(ciscoConfigBackups.id, [aId, bId])));
    const a = rows.find((r) => r.id === aId);
    const b = rows.find((r) => r.id === bId);
    if (!a || !b) throw new NotFoundException("Backup not found");
    return diffConfigs(a.configText, b.configText);
  }

  async deleteBackup(switchId: string, backupId: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .delete(ciscoConfigBackups)
      .where(and(eq(ciscoConfigBackups.id, backupId), eq(ciscoConfigBackups.switchId, switchId)))
      .returning();
    if (!row) throw new NotFoundException("Backup not found");
    return { ok: true };
  }

  async backupStatus(): Promise<{ latest: string | null; total: number }> {
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(ciscoConfigBackups);
    const [latest] = await this.db
      .select({ at: ciscoConfigBackups.backedUpAt })
      .from(ciscoConfigBackups)
      .orderBy(desc(ciscoConfigBackups.backedUpAt))
      .limit(1);
    return { latest: latest?.at ? latest.at.toISOString() : null, total: Number(total) };
  }

  // ---- drift ----

  async drift(switchId: string): Promise<CiscoDriftEvent[]> {
    await this.rowById(switchId);
    const rows = await this.db
      .select()
      .from(ciscoDriftEvents)
      .where(eq(ciscoDriftEvents.switchId, switchId))
      .orderBy(desc(ciscoDriftEvents.detectedAt))
      .limit(200);
    return rows.map((r) => ({
      id: r.id,
      portId: r.portId,
      field: r.field,
      expected: r.expected,
      observed: r.observed,
      detectedAt: r.detectedAt.toISOString(),
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
    }));
  }

  /** Open drift events (for push/accept-all orchestration). */
  async openDrift(switchId: string, driftId?: string) {
    const conds = [eq(ciscoDriftEvents.switchId, switchId), isNull(ciscoDriftEvents.resolvedAt)];
    if (driftId) conds.push(eq(ciscoDriftEvents.id, driftId));
    return this.db.select().from(ciscoDriftEvents).where(and(...conds));
  }

  async resolveAllDrift(switchId: string): Promise<{ ok: true }> {
    await this.db
      .update(ciscoDriftEvents)
      .set({ resolvedAt: new Date() })
      .where(and(eq(ciscoDriftEvents.switchId, switchId), isNull(ciscoDriftEvents.resolvedAt)));
    await this.db.update(ciscoSwitches).set({ configDrift: false }).where(eq(ciscoSwitches.id, switchId));
    return { ok: true };
  }

  /** Adopt observed values into the desired config (ports/switch), then resolve. */
  async acceptDrift(switchId: string, driftId?: string): Promise<{ ok: true; count: number }> {
    const open = await this.openDrift(switchId, driftId);
    for (const d of open) {
      if (d.portId === "__device__") {
        const col = d.field === "hostname" ? "hostname" : d.field === "location" ? "location" : d.field === "model" ? "model" : null;
        if (col) {
          await this.db
            .update(ciscoSwitches)
            .set({ [col]: d.observed, updatedAt: new Date() })
            .where(eq(ciscoSwitches.id, switchId));
        }
      } else if (ACCEPTABLE_PORT_FIELDS.has(d.field)) {
        await this.db
          .update(ciscoPorts)
          .set({ ...portFieldPatch(d.field, d.observed), updatedAt: new Date() })
          .where(and(eq(ciscoPorts.switchId, switchId), eq(ciscoPorts.portId, d.portId)));
      }
    }
    const ids = open.map((d) => d.id);
    if (ids.length) {
      await this.db
        .update(ciscoDriftEvents)
        .set({ resolvedAt: new Date() })
        .where(inArray(ciscoDriftEvents.id, ids));
    }
    await this.recomputeDrift(switchId);
    return { ok: true, count: open.length };
  }

  async markResolved(driftIds: string[]): Promise<void> {
    if (!driftIds.length) return;
    await this.db
      .update(ciscoDriftEvents)
      .set({ resolvedAt: new Date() })
      .where(inArray(ciscoDriftEvents.id, driftIds));
  }

  async recomputeDrift(switchId: string): Promise<void> {
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoDriftEvents)
      .where(and(eq(ciscoDriftEvents.switchId, switchId), isNull(ciscoDriftEvents.resolvedAt)));
    await this.db.update(ciscoSwitches).set({ configDrift: Number(n) > 0 }).where(eq(ciscoSwitches.id, switchId));
  }

  // ---- MAC / ARP lookup ----

  async lookup(
    q: string | null,
    excludeUplinks: boolean,
  ): Promise<{ results: CiscoLookupRow[]; arpOnly: CiscoArpOnlyRow[] }> {
    // q null = browse all entries (client filters). A term = server substring
    // search with a tighter cap.
    const like = q ? `%${q}%` : null;
    const base = this.db
      .select({
        macAddress: ciscoMacTable.macAddress,
        ipAddress: ciscoArpCache.ipAddress,
        rdnsName: ciscoArpCache.rdnsName,
        vrf: ciscoArpCache.vrf,
        switchId: ciscoMacTable.switchId,
        switchHostname: ciscoSwitches.hostname,
        portId: ciscoMacTable.portId,
        portDescription: ciscoPorts.description,
        vlan: ciscoMacTable.vlan,
        macType: ciscoMacTable.macType,
        polledAt: ciscoMacTable.polledAt,
        uplinkNeighbor: ciscoNeighbors.neighborHostname,
      })
      .from(ciscoMacTable)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoMacTable.switchId))
      .leftJoin(
        ciscoArpCache,
        and(eq(ciscoArpCache.switchId, ciscoMacTable.switchId), eq(ciscoArpCache.macAddress, ciscoMacTable.macAddress)),
      )
      .leftJoin(
        ciscoPorts,
        and(eq(ciscoPorts.switchId, ciscoMacTable.switchId), eq(ciscoPorts.portId, ciscoMacTable.portId)),
      )
      .leftJoin(
        ciscoNeighbors,
        and(eq(ciscoNeighbors.switchId, ciscoMacTable.switchId), eq(ciscoNeighbors.localPort, ciscoMacTable.portId)),
      )
      .where(
        and(
          like
            ? or(
                ilike(ciscoMacTable.macAddress, like),
                ilike(ciscoArpCache.ipAddress, like),
                ilike(ciscoArpCache.rdnsName, like),
                ilike(ciscoPorts.description, like),
                ilike(ciscoSwitches.hostname, like),
              )
            : sql`true`,
          excludeUplinks ? isNull(ciscoNeighbors.id) : sql`true`,
        ),
      )
      .limit(like ? 100 : 2000);
    const results = (await base).map(
      (r): CiscoLookupRow => ({
        macAddress: r.macAddress,
        ipAddress: r.ipAddress ?? null,
        rdnsName: r.rdnsName ?? null,
        vrf: r.vrf ?? null,
        switchId: r.switchId,
        switchHostname: r.switchHostname,
        portId: r.portId,
        portDescription: r.portDescription ?? null,
        vlan: r.vlan,
        macType: r.macType,
        polledAt: r.polledAt ? r.polledAt.toISOString() : null,
        uplinkNeighbor: r.uplinkNeighbor ?? null,
      }),
    );

    // ARP entries with no matching MAC (endpoints seen only in ARP).
    const matchedMacs = new Set(results.map((r) => r.macAddress).filter(Boolean) as string[]);
    const arpRows = await this.db
      .select({
        ipAddress: ciscoArpCache.ipAddress,
        macAddress: ciscoArpCache.macAddress,
        interface: ciscoArpCache.interface,
        vlan: ciscoArpCache.vlan,
        vrf: ciscoArpCache.vrf,
        rdnsName: ciscoArpCache.rdnsName,
        switchId: ciscoArpCache.switchId,
        switchHostname: ciscoSwitches.hostname,
        polledAt: ciscoArpCache.polledAt,
      })
      .from(ciscoArpCache)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoArpCache.switchId))
      .where(
        like
          ? or(ilike(ciscoArpCache.ipAddress, like), ilike(ciscoArpCache.rdnsName, like), ilike(ciscoArpCache.macAddress, like))
          : sql`true`,
      )
      .limit(like ? 50 : 1000);
    const arpOnly = arpRows
      .filter((r) => !r.macAddress || !matchedMacs.has(r.macAddress))
      .map(
        (r): CiscoArpOnlyRow => ({
          ipAddress: r.ipAddress,
          macAddress: r.macAddress ?? null,
          interface: r.interface ?? null,
          vlan: r.vlan,
          vrf: r.vrf ?? null,
          rdnsName: r.rdnsName ?? null,
          switchId: r.switchId,
          switchHostname: r.switchHostname,
          polledAt: r.polledAt ? r.polledAt.toISOString() : null,
        }),
      );
    return { results, arpOnly };
  }

  /**
   * Server-paginated MAC table (mac joined to arp for IP/hostname). Returns the
   * requested page plus the total match count so the UI can paginate. Search +
   * sort + exclude-uplinks all run server-side so it scales past what a
   * client-side table can hold.
   */
  async macTable(opts: {
    q: string | null;
    excludeUplinks: boolean;
    limit: number;
    offset: number;
    sort: string;
    dir: "asc" | "desc";
  }): Promise<{ rows: CiscoLookupRow[]; total: number }> {
    const like = opts.q ? `%${opts.q}%` : null;
    const where = and(
      like
        ? or(
            ilike(ciscoMacTable.macAddress, like),
            ilike(ciscoArpCache.ipAddress, like),
            ilike(ciscoArpCache.rdnsName, like),
            ilike(ciscoPorts.description, like),
            ilike(ciscoSwitches.hostname, like),
          )
        : sql`true`,
      opts.excludeUplinks ? isNull(ciscoNeighbors.id) : sql`true`,
    );

    const sortColumn =
      opts.sort === "ip"
        ? ciscoArpCache.ipAddress
        : opts.sort === "host"
          ? ciscoArpCache.rdnsName
          : opts.sort === "switch"
            ? ciscoSwitches.hostname
            : opts.sort === "port"
              ? ciscoMacTable.portId
              : opts.sort === "vlan"
                ? ciscoMacTable.vlan
                : opts.sort === "type"
                  ? ciscoMacTable.macType
                  : ciscoMacTable.macAddress;
    const orderExpr = opts.dir === "desc" ? desc(sortColumn) : asc(sortColumn);

    const [countRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoMacTable)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoMacTable.switchId))
      .leftJoin(
        ciscoArpCache,
        and(eq(ciscoArpCache.switchId, ciscoMacTable.switchId), eq(ciscoArpCache.macAddress, ciscoMacTable.macAddress)),
      )
      .leftJoin(
        ciscoPorts,
        and(eq(ciscoPorts.switchId, ciscoMacTable.switchId), eq(ciscoPorts.portId, ciscoMacTable.portId)),
      )
      .leftJoin(
        ciscoNeighbors,
        and(eq(ciscoNeighbors.switchId, ciscoMacTable.switchId), eq(ciscoNeighbors.localPort, ciscoMacTable.portId)),
      )
      .where(where);

    const rows = await this.db
      .select({
        macAddress: ciscoMacTable.macAddress,
        ipAddress: ciscoArpCache.ipAddress,
        rdnsName: ciscoArpCache.rdnsName,
        vrf: ciscoArpCache.vrf,
        switchId: ciscoMacTable.switchId,
        switchHostname: ciscoSwitches.hostname,
        portId: ciscoMacTable.portId,
        portDescription: ciscoPorts.description,
        vlan: ciscoMacTable.vlan,
        macType: ciscoMacTable.macType,
        polledAt: ciscoMacTable.polledAt,
        uplinkNeighbor: ciscoNeighbors.neighborHostname,
      })
      .from(ciscoMacTable)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoMacTable.switchId))
      .leftJoin(
        ciscoArpCache,
        and(eq(ciscoArpCache.switchId, ciscoMacTable.switchId), eq(ciscoArpCache.macAddress, ciscoMacTable.macAddress)),
      )
      .leftJoin(
        ciscoPorts,
        and(eq(ciscoPorts.switchId, ciscoMacTable.switchId), eq(ciscoPorts.portId, ciscoMacTable.portId)),
      )
      .leftJoin(
        ciscoNeighbors,
        and(eq(ciscoNeighbors.switchId, ciscoMacTable.switchId), eq(ciscoNeighbors.localPort, ciscoMacTable.portId)),
      )
      .where(where)
      .orderBy(orderExpr, asc(ciscoMacTable.id))
      .limit(opts.limit)
      .offset(opts.offset);

    return {
      total: Number(countRow?.n ?? 0),
      rows: rows.map((r) => ({
        macAddress: r.macAddress,
        ipAddress: r.ipAddress ?? null,
        rdnsName: r.rdnsName ?? null,
        vrf: r.vrf ?? null,
        switchId: r.switchId,
        switchHostname: r.switchHostname,
        portId: r.portId,
        portDescription: r.portDescription ?? null,
        vlan: r.vlan,
        macType: r.macType,
        polledAt: r.polledAt ? r.polledAt.toISOString() : null,
        uplinkNeighbor: r.uplinkNeighbor ?? null,
      })),
    };
  }

  async macForSwitch(switchId: string) {
    await this.rowById(switchId);
    const rows = await this.db
      .select({
        macAddress: ciscoMacTable.macAddress,
        vlan: ciscoMacTable.vlan,
        portId: ciscoMacTable.portId,
        macType: ciscoMacTable.macType,
        polledAt: ciscoMacTable.polledAt,
        ipAddress: ciscoArpCache.ipAddress,
        rdnsName: ciscoArpCache.rdnsName,
        vrf: ciscoArpCache.vrf,
        portDescription: ciscoPorts.description,
      })
      .from(ciscoMacTable)
      .leftJoin(
        ciscoArpCache,
        and(eq(ciscoArpCache.switchId, ciscoMacTable.switchId), eq(ciscoArpCache.macAddress, ciscoMacTable.macAddress)),
      )
      .leftJoin(
        ciscoPorts,
        and(eq(ciscoPorts.switchId, ciscoMacTable.switchId), eq(ciscoPorts.portId, ciscoMacTable.portId)),
      )
      .where(eq(ciscoMacTable.switchId, switchId))
      .orderBy(asc(ciscoMacTable.vlan), asc(ciscoMacTable.macAddress));
    return rows.map((r) => ({
      macAddress: r.macAddress,
      vlan: r.vlan,
      portId: r.portId,
      macType: r.macType,
      polledAt: r.polledAt ? r.polledAt.toISOString() : null,
      ipAddress: r.ipAddress ?? null,
      rdnsName: r.rdnsName ?? null,
      vrf: r.vrf ?? null,
      portDescription: r.portDescription ?? null,
    }));
  }

  // ---- ports (desired config editing) ----

  async portsForSwitch(switchId: string): Promise<CiscoPortRow[]> {
    await this.rowById(switchId);
    const rows = await this.db
      .select({
        id: ciscoPorts.id,
        portId: ciscoPorts.portId,
        description: ciscoPorts.description,
        adminEnabled: ciscoPorts.adminEnabled,
        speed: ciscoPorts.speed,
        duplex: ciscoPorts.duplex,
        mode: ciscoPorts.mode,
        hasSwitchport: ciscoPorts.hasSwitchport,
        accessVlan: ciscoPorts.accessVlan,
        trunkNativeVlan: ciscoPorts.trunkNativeVlan,
        trunkAllowedVlans: ciscoPorts.trunkAllowedVlans,
        neighborHostname: ciscoPorts.neighborHostname,
        neighborPort: ciscoPorts.neighborPort,
        operStatus: ciscoPortLiveState.operStatus,
      })
      .from(ciscoPorts)
      .leftJoin(
        ciscoPortLiveState,
        and(eq(ciscoPortLiveState.switchId, ciscoPorts.switchId), eq(ciscoPortLiveState.portId, ciscoPorts.portId)),
      )
      .where(eq(ciscoPorts.switchId, switchId))
      .orderBy(asc(ciscoPorts.portId));
    return rows.map((r) => ({ ...r, operStatus: r.operStatus ?? null }));
  }

  async createPort(switchId: string, input: CiscoPortInput): Promise<{ id: string; portId: string }> {
    await this.rowById(switchId);
    const [dup] = await this.db
      .select({ id: ciscoPorts.id })
      .from(ciscoPorts)
      .where(and(eq(ciscoPorts.switchId, switchId), eq(ciscoPorts.portId, input.portId)))
      .limit(1);
    if (dup) throw new ConflictException("That port already exists on this switch");
    const [row] = await this.db
      .insert(ciscoPorts)
      .values({ switchId, portId: input.portId, ...portInsert(input) })
      .returning({ id: ciscoPorts.id, portId: ciscoPorts.portId });
    return row!;
  }

  async updatePort(
    switchId: string,
    portRowId: string,
    input: UpdateCiscoPortInput,
  ): Promise<{ id: string; portId: string }> {
    const [row] = await this.db
      .update(ciscoPorts)
      .set({ ...portInsert(input), updatedAt: new Date() })
      .where(and(eq(ciscoPorts.id, portRowId), eq(ciscoPorts.switchId, switchId)))
      .returning({ id: ciscoPorts.id, portId: ciscoPorts.portId });
    if (!row) throw new NotFoundException("Port not found");
    return row;
  }

  async deletePort(switchId: string, portRowId: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .delete(ciscoPorts)
      .where(and(eq(ciscoPorts.id, portRowId), eq(ciscoPorts.switchId, switchId)))
      .returning({ id: ciscoPorts.id });
    if (!row) throw new NotFoundException("Port not found");
    return { ok: true };
  }

  // ---- fleet-wide backups + drift (sortable/filterable tables) ----

  /** Server-paginated fleet config-backup list (search + sort + page). */
  async allBackups(opts: {
    q: string | null;
    limit: number;
    offset: number;
    sort: string;
    dir: "asc" | "desc";
  }): Promise<{ rows: CiscoBackupRow[]; total: number }> {
    const like = opts.q ? `%${opts.q}%` : null;
    const where = like
      ? or(
          ilike(ciscoSwitches.hostname, like),
          ilike(ciscoConfigBackups.backupType, like),
          ilike(ciscoConfigBackups.checksum, like),
        )
      : sql`true`;
    const sortColumn =
      opts.sort === "switch"
        ? ciscoSwitches.hostname
        : opts.sort === "type"
          ? ciscoConfigBackups.backupType
          : opts.sort === "size"
            ? sql`length(${ciscoConfigBackups.configText})`
            : opts.sort === "cksum"
              ? ciscoConfigBackups.checksum
              : ciscoConfigBackups.backedUpAt;
    const orderExpr = opts.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [countRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoConfigBackups)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoConfigBackups.switchId))
      .where(where);

    const rows = await this.db
      .select({
        id: ciscoConfigBackups.id,
        switchId: ciscoConfigBackups.switchId,
        switchHostname: ciscoSwitches.hostname,
        backupType: ciscoConfigBackups.backupType,
        backedUpAt: ciscoConfigBackups.backedUpAt,
        checksum: ciscoConfigBackups.checksum,
        configSize: sql<number>`length(${ciscoConfigBackups.configText})::int`,
      })
      .from(ciscoConfigBackups)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoConfigBackups.switchId))
      .where(where)
      .orderBy(orderExpr, desc(ciscoConfigBackups.id))
      .limit(opts.limit)
      .offset(opts.offset);

    return {
      total: Number(countRow?.n ?? 0),
      rows: rows.map((r) => ({
        id: r.id,
        switchId: r.switchId,
        switchHostname: r.switchHostname,
        backupType: r.backupType as CiscoBackupListItem["backupType"],
        backedUpAt: r.backedUpAt.toISOString(),
        checksum: r.checksum,
        configSize: Number(r.configSize),
      })),
    };
  }

  /** Server-paginated fleet open-drift list (search + sort + page). */
  async allOpenDrift(opts: {
    q: string | null;
    limit: number;
    offset: number;
    sort: string;
    dir: "asc" | "desc";
  }): Promise<{ rows: CiscoDriftRow[]; total: number }> {
    const like = opts.q ? `%${opts.q}%` : null;
    const where = and(
      isNull(ciscoDriftEvents.resolvedAt),
      like
        ? or(
            ilike(ciscoSwitches.hostname, like),
            ilike(ciscoDriftEvents.portId, like),
            ilike(ciscoDriftEvents.field, like),
            ilike(ciscoDriftEvents.expected, like),
            ilike(ciscoDriftEvents.observed, like),
          )
        : sql`true`,
    );
    const sortColumn =
      opts.sort === "switch"
        ? ciscoSwitches.hostname
        : opts.sort === "scope"
          ? ciscoDriftEvents.portId
          : opts.sort === "field"
            ? ciscoDriftEvents.field
            : opts.sort === "expected"
              ? ciscoDriftEvents.expected
              : opts.sort === "observed"
                ? ciscoDriftEvents.observed
                : ciscoDriftEvents.detectedAt;
    const orderExpr = opts.dir === "asc" ? asc(sortColumn) : desc(sortColumn);

    const [countRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoDriftEvents)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoDriftEvents.switchId))
      .where(where);

    const rows = await this.db
      .select({
        id: ciscoDriftEvents.id,
        switchId: ciscoDriftEvents.switchId,
        switchHostname: ciscoSwitches.hostname,
        portId: ciscoDriftEvents.portId,
        field: ciscoDriftEvents.field,
        expected: ciscoDriftEvents.expected,
        observed: ciscoDriftEvents.observed,
        detectedAt: ciscoDriftEvents.detectedAt,
        resolvedAt: ciscoDriftEvents.resolvedAt,
      })
      .from(ciscoDriftEvents)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoDriftEvents.switchId))
      .where(where)
      .orderBy(orderExpr, desc(ciscoDriftEvents.id))
      .limit(opts.limit)
      .offset(opts.offset);

    return {
      total: Number(countRow?.n ?? 0),
      rows: rows.map((r) => ({
        id: r.id,
        switchId: r.switchId,
        switchHostname: r.switchHostname,
        portId: r.portId,
        field: r.field,
        expected: r.expected,
        observed: r.observed,
        detectedAt: r.detectedAt.toISOString(),
        resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      })),
    };
  }

  // ---- topology (from LLDP/CDP neighbors) ----

  async topology(): Promise<CiscoTopology> {
    const [switches, neighbors] = await Promise.all([
      this.db
        .select({ hostname: ciscoSwitches.hostname, reachable: ciscoSwitches.reachable })
        .from(ciscoSwitches),
      this.db
        .select({
          localPort: ciscoNeighbors.localPort,
          neighborHostname: ciscoNeighbors.neighborHostname,
          neighborPort: ciscoNeighbors.neighborPort,
          protocol: ciscoNeighbors.protocol,
          switchHostname: ciscoSwitches.hostname,
        })
        .from(ciscoNeighbors)
        .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoNeighbors.switchId)),
    ]);
    const knownHosts = new Map(switches.map((s) => [s.hostname.toLowerCase(), s]));
    const nodes = new Map<string, CiscoTopologyNode>();
    for (const s of switches) nodes.set(s.hostname, { id: s.hostname, label: s.hostname, kind: "switch", reachable: s.reachable });

    const edges: CiscoTopologyEdge[] = [];
    const seen = new Set<string>();
    for (const n of neighbors) {
      if (!n.neighborHostname) continue;
      const a = n.switchHostname;
      const b = n.neighborHostname;
      if (!nodes.has(b)) {
        nodes.set(b, {
          id: b,
          label: b,
          kind: knownHosts.has(b.toLowerCase()) ? "switch" : "external",
        });
      }
      const key = [a, b].sort().join("|") + `|${n.localPort}|${n.neighborPort ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a, b, aPort: n.localPort, bPort: n.neighborPort ?? null, protocol: n.protocol });
    }
    return { nodes: [...nodes.values()], edges };
  }

  // ---- VLAN database (fleet-wide) ----

  async vlans(): Promise<CiscoVlanRow[]> {
    const rows = await this.db
      .select({
        vlanId: ciscoVlanDb.vlanId,
        vlanName: ciscoVlanDb.vlanName,
        vlanStatus: ciscoVlanDb.vlanStatus,
        switchId: ciscoVlanDb.switchId,
        hostname: ciscoSwitches.hostname,
      })
      .from(ciscoVlanDb)
      .innerJoin(ciscoSwitches, eq(ciscoSwitches.id, ciscoVlanDb.switchId))
      .orderBy(asc(ciscoVlanDb.vlanId), asc(ciscoSwitches.hostname));
    const byId = new Map<number, CiscoVlanRow>();
    for (const r of rows) {
      let row = byId.get(r.vlanId);
      if (!row) {
        row = { vlanId: r.vlanId, nameConflict: false, switches: [] };
        byId.set(r.vlanId, row);
      }
      row.switches.push({ switchId: r.switchId, hostname: r.hostname, vlanName: r.vlanName, vlanStatus: r.vlanStatus });
    }
    for (const row of byId.values()) {
      const names = new Set(row.switches.map((s) => (s.vlanName ?? "").toLowerCase()).filter(Boolean));
      row.nameConflict = names.size > 1;
    }
    return [...byId.values()].sort((a, b) => a.vlanId - b.vlanId);
  }
}

function toSwitch(row: SwitchRow): CiscoSwitch {
  return {
    id: row.id,
    hostname: row.hostname,
    ipAddress: row.ipAddress,
    username: row.username,
    model: row.model ?? null,
    location: row.location ?? null,
    reachable: row.reachable,
    uptime: row.uptime ?? null,
    lastPolledAt: row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
    lastError: row.lastError ?? null,
    configDrift: row.configDrift,
    checkPortState: row.checkPortState,
    alertPrefs: normalizePrefs(row.alertPrefs),
    hasPassword: Boolean(row.passwordEnc),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Coerce a stored/partial alert-prefs blob into a full CiscoAlertPrefs (all off by default). */
export function normalizePrefs(raw: unknown): CiscoAlertPrefs {
  const p = (raw ?? {}) as Partial<CiscoAlertPrefs>;
  return {
    deviceOffline: p.deviceOffline === true,
    portStateChange: p.portStateChange === true,
    configChange: p.configChange === true,
    uptimeChange: p.uptimeChange === true,
  };
}

function portInsert(input: CiscoPortInput | UpdateCiscoPortInput): Partial<typeof ciscoPorts.$inferInsert> {
  const p: Partial<typeof ciscoPorts.$inferInsert> = {};
  if (input.portId !== undefined) p.portId = input.portId;
  if (input.description !== undefined) p.description = input.description;
  if (input.adminEnabled !== undefined) p.adminEnabled = input.adminEnabled;
  if (input.speed !== undefined) p.speed = input.speed;
  if (input.duplex !== undefined) p.duplex = input.duplex;
  if (input.mode !== undefined) p.mode = input.mode;
  if (input.hasSwitchport !== undefined) p.hasSwitchport = input.hasSwitchport;
  if (input.accessVlan !== undefined) p.accessVlan = input.accessVlan;
  if (input.trunkNativeVlan !== undefined) p.trunkNativeVlan = input.trunkNativeVlan;
  if (input.trunkAllowedVlans !== undefined) p.trunkAllowedVlans = input.trunkAllowedVlans;
  return p;
}

function portFieldPatch(field: string, observed: string | null): Partial<typeof ciscoPorts.$inferInsert> {
  switch (field) {
    case "admin_enabled":
      return { adminEnabled: observed === "1" || observed === "true" };
    case "access_vlan":
      return { accessVlan: Number(observed) || 1 };
    case "trunk_native_vlan":
      return { trunkNativeVlan: Number(observed) || 1 };
    case "speed":
      return { speed: observed ?? "auto" };
    case "duplex":
      return { duplex: observed ?? "auto" };
    case "mode":
      return { mode: observed ?? "access" };
    case "trunk_allowed_vlans":
      return { trunkAllowedVlans: observed ?? "1-4094" };
    case "description":
      return { description: observed ?? "" };
    default:
      return {};
  }
}
