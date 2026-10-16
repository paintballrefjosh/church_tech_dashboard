import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  ciscoConfigBackups,
  ciscoDriftEvents,
  ciscoPortLiveState,
  ciscoPorts,
  ciscoSwitches,
  ciscoVlanDb,
  ciscoVlans,
} from "../db/schema";
import {
  defaultVlanName,
  isManagedVlan,
  type CiscoSwitchVlan,
  type CiscoVlanRow,
  type CiscoVlanSetResult,
  type CiscoVlanState,
} from "@church/shared";
import {
  VLAN_FIELD_EXISTS,
  VLAN_FIELD_NAME,
  computeVlanDrift,
  desiredNameFromObserved,
  effectiveVlanName,
  parseVlanScope,
  vlanScope,
  type VlanUse,
} from "./vlan-drift";
import type { PushChange } from "./push-commands";

type DriftRow = typeof ciscoDriftEvents.$inferSelect;

/** "A, B, C and 12 more": a switch with many ports in a VLAN must not fill the error. */
function listUses(uses: VlanUse[], max = 4): string {
  const shown = uses.slice(0, max).map((u) => u.detail);
  return uses.length > max ? `${shown.join(", ")} and ${uses.length - max} more` : shown.join(", ");
}

function blockedMessage(vlanId: number, blocked: Array<{ hostname: string; uses: VlanUse[] }>): string {
  return `VLAN ${vlanId} is still in use: ${blocked.map((b) => `${b.hostname} (${listUses(b.uses)})`).join("; ")}`;
}

/**
 * Layer 2 VLAN management: the wanted VLANs per switch (`cisco_vlans`), their comparison with what each switch
 * reports (`cisco_vlan_db`, written by the poller), and the edits that change the wanted side. Nothing here talks to
 * a switch: a change becomes drift, and the drift push sends it (CiscoPoller.pushToSwitch).
 */
@Injectable()
export class CiscoVlansService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- reading ----

  /** The VLANs a port on this switch can be put in: VLAN 1 plus the switch's wanted VLANs. */
  async forSwitch(switchId: string): Promise<CiscoSwitchVlan[]> {
    await this.requireSwitch(switchId);
    const rows = await this.db
      .select({ vlanId: ciscoVlans.vlanId, name: ciscoVlans.name })
      .from(ciscoVlans)
      .where(eq(ciscoVlans.switchId, switchId))
      .orderBy(asc(ciscoVlans.vlanId));
    return [
      { vlanId: 1, name: "default" },
      ...rows.map((r) => ({ vlanId: r.vlanId, name: effectiveVlanName(r.vlanId, r.name) })),
    ];
  }

  /**
   * Every VLAN across the fleet, each with the switches that want it or have it and how the two compare.
   * Names that differ between switches (wanted name where there is one, else the reported one) are flagged.
   */
  async fleetView(): Promise<CiscoVlanRow[]> {
    const [observed, desired, switches] = await Promise.all([
      this.db
        .select({ switchId: ciscoVlanDb.switchId, vlanId: ciscoVlanDb.vlanId, vlanName: ciscoVlanDb.vlanName, vlanStatus: ciscoVlanDb.vlanStatus })
        .from(ciscoVlanDb),
      this.db.select({ switchId: ciscoVlans.switchId, vlanId: ciscoVlans.vlanId, name: ciscoVlans.name }).from(ciscoVlans),
      this.db.select({ id: ciscoSwitches.id, hostname: ciscoSwitches.hostname }).from(ciscoSwitches),
    ]);
    const host = new Map(switches.map((s) => [s.id, s.hostname]));
    const key = (switchId: string, vlanId: number) => `${switchId}|${vlanId}`;
    const obsBy = new Map(observed.map((o) => [key(o.switchId, o.vlanId), o]));
    const wantBy = new Map(desired.map((d) => [key(d.switchId, d.vlanId), d]));
    const ids = new Set<number>([...observed.map((o) => o.vlanId), ...desired.map((d) => d.vlanId)]);

    const rows: CiscoVlanRow[] = [];
    for (const vlanId of [...ids].sort((a, b) => a - b)) {
      const managed = isManagedVlan(vlanId);
      const switchIds = new Set<string>([
        ...observed.filter((o) => o.vlanId === vlanId).map((o) => o.switchId),
        ...desired.filter((d) => d.vlanId === vlanId).map((d) => d.switchId),
      ]);
      const entries = [...switchIds]
        .filter((id) => host.has(id))
        .map((switchId) => {
          const o = obsBy.get(key(switchId, vlanId));
          const d = wantBy.get(key(switchId, vlanId));
          let state: CiscoVlanState = "in_sync";
          if (managed) {
            if (d && !o) state = "missing";
            else if (!d && o) state = "extra";
            else if (d && o && effectiveVlanName(vlanId, d.name) !== effectiveVlanName(vlanId, o.vlanName)) state = "name";
          }
          return {
            switchId,
            hostname: host.get(switchId)!,
            vlanName: o ? o.vlanName : null,
            vlanStatus: o ? o.vlanStatus : null,
            desired: !!d,
            desiredName: d ? effectiveVlanName(vlanId, d.name) : null,
            state,
          };
        })
        .sort((a, b) => a.hostname.localeCompare(b.hostname));
      const names = new Set(
        entries.map((e) => (e.desiredName ?? effectiveVlanName(vlanId, e.vlanName)).toLowerCase()),
      );
      rows.push({ vlanId, nameConflict: names.size > 1, managed, switches: entries });
    }
    return rows;
  }

  // ---- editing the wanted side ----

  /**
   * Make `name` and `switchIds` the wanted state of one VLAN: switches in the list get it (added or renamed), switches
   * that have it wanted but are not in the list lose it. All or nothing: a name already used by another VLAN on a
   * target switch, or a VLAN that is still in use where it would be removed, refuses the whole change.
   */
  async setVlan(vlanId: number, name: string, switchIds: string[]): Promise<CiscoVlanSetResult> {
    this.assertManaged(vlanId);
    const targets = [...new Set(switchIds)];
    const switches = await this.switchesById([
      ...targets,
      ...(await this.db.select({ id: ciscoVlans.switchId }).from(ciscoVlans).where(eq(ciscoVlans.vlanId, vlanId))).map((r) => r.id),
    ]);
    for (const id of targets) if (!switches.has(id)) throw new NotFoundException(`Switch ${id} not found`);

    // A switch that has not been baselined yet is baselined first, or the edit would hide its other VLANs.
    for (const id of switches.keys()) await this.ensureBaseline(id);

    const current = await this.db.select().from(ciscoVlans).where(eq(ciscoVlans.vlanId, vlanId));
    const currentBy = new Map(current.map((r) => [r.switchId, r]));
    const wantName = effectiveVlanName(vlanId, name);

    // A name can be on one VLAN per switch.
    const clashes: string[] = [];
    for (const switchId of targets) {
      const others = await this.db
        .select({ vlanId: ciscoVlans.vlanId, name: ciscoVlans.name })
        .from(ciscoVlans)
        .where(eq(ciscoVlans.switchId, switchId));
      const taken = others.find((o) => o.vlanId !== vlanId && effectiveVlanName(o.vlanId, o.name).toLowerCase() === wantName.toLowerCase());
      if (taken) clashes.push(`${switches.get(switchId)!.hostname} already has VLAN ${taken.vlanId} named ${wantName}`);
    }
    if (clashes.length) throw new ConflictException({ message: clashes.join("; "), clashes });

    const removeFrom = current.filter((r) => !targets.includes(r.switchId)).map((r) => r.switchId);
    const blocked: Array<{ switchId: string; hostname: string; reasons: string[]; uses: VlanUse[] }> = [];
    for (const switchId of removeFrom) {
      const uses = await this.usage(switchId, vlanId);
      if (uses.length) blocked.push({ switchId, hostname: switches.get(switchId)!.hostname, reasons: uses.map((u) => u.detail), uses });
    }
    if (blocked.length) throw new ConflictException({ message: blockedMessage(vlanId, blocked), blocked: blocked.map(({ uses: _uses, ...rest }) => rest) });

    const result: CiscoVlanSetResult = { vlanId, created: [], renamed: [], removed: [], unchanged: [] };
    await this.db.transaction(async (tx) => {
      const now = new Date();
      for (const switchId of targets) {
        const host = switches.get(switchId)!.hostname;
        const row = currentBy.get(switchId);
        if (!row) {
          await tx.insert(ciscoVlans).values({ switchId, vlanId, name: name.trim() });
          result.created.push(host);
        } else if (effectiveVlanName(vlanId, row.name) !== wantName) {
          await tx.update(ciscoVlans).set({ name: name.trim(), updatedAt: now }).where(eq(ciscoVlans.id, row.id));
          result.renamed.push(host);
        } else result.unchanged.push(host);
      }
      if (removeFrom.length) {
        await tx.delete(ciscoVlans).where(and(eq(ciscoVlans.vlanId, vlanId), inArray(ciscoVlans.switchId, removeFrom)));
        for (const switchId of removeFrom) result.removed.push(switches.get(switchId)!.hostname);
      }
    });
    for (const switchId of new Set([...targets, ...removeFrom])) await this.detect(switchId);
    return result;
  }

  /** Remove a VLAN from every switch's wanted list (refused while any port, native VLAN or VLAN interface uses it). */
  async removeVlan(vlanId: number): Promise<CiscoVlanSetResult> {
    this.assertManaged(vlanId);
    const rows = await this.db.select({ id: ciscoVlans.switchId }).from(ciscoVlans).where(eq(ciscoVlans.vlanId, vlanId));
    if (rows.length === 0) throw new NotFoundException(`VLAN ${vlanId} is not in any switch's wanted list`);
    const switches = await this.switchesById(rows.map((r) => r.id));
    const blocked: Array<{ switchId: string; hostname: string; reasons: string[]; uses: VlanUse[] }> = [];
    for (const r of rows) {
      const uses = await this.usage(r.id, vlanId);
      if (uses.length) blocked.push({ switchId: r.id, hostname: switches.get(r.id)!.hostname, reasons: uses.map((u) => u.detail), uses });
    }
    if (blocked.length) throw new ConflictException({ message: blockedMessage(vlanId, blocked), blocked: blocked.map(({ uses: _uses, ...rest }) => rest) });
    await this.db.delete(ciscoVlans).where(eq(ciscoVlans.vlanId, vlanId));
    for (const r of rows) await this.detect(r.id);
    return { vlanId, created: [], renamed: [], removed: rows.map((r) => switches.get(r.id)!.hostname), unchanged: [] };
  }

  // ---- what uses a VLAN ----

  /**
   * What still uses a VLAN on a switch: wanted or live access ports, trunk native VLANs, and a VLAN interface (SVI) in
   * the latest saved config. Removing a VLAN that is in use leaves its ports inactive (or its gateway down).
   */
  async usage(switchId: string, vlanId: number): Promise<VlanUse[]> {
    const uses: VlanUse[] = [];
    const seen = new Set<string>();
    const ports = await this.db.select().from(ciscoPorts).where(eq(ciscoPorts.switchId, switchId));
    for (const p of ports) {
      if (p.hasSwitchport && p.mode === "access" && p.accessVlan === vlanId) {
        seen.add(p.portId);
        uses.push({ kind: "access_port", detail: `${p.portId} is an access port in it` });
      } else if (p.hasSwitchport && p.mode === "trunk" && p.trunkNativeVlan === vlanId) {
        seen.add(p.portId);
        uses.push({ kind: "native_port", detail: `${p.portId} uses it as its trunk native VLAN` });
      }
    }
    const live = await this.db
      .select({ portId: ciscoPortLiveState.portId, mode: ciscoPortLiveState.mode })
      .from(ciscoPortLiveState)
      .where(and(eq(ciscoPortLiveState.switchId, switchId), eq(ciscoPortLiveState.accessVlan, vlanId)));
    for (const l of live) {
      if (seen.has(l.portId) || l.mode === "trunk") continue;
      uses.push({ kind: "access_port", detail: `${l.portId} is in it on the switch` });
    }
    const [backup] = await this.db
      .select({ config: ciscoConfigBackups.configText })
      .from(ciscoConfigBackups)
      .where(eq(ciscoConfigBackups.switchId, switchId))
      .orderBy(desc(ciscoConfigBackups.backedUpAt))
      .limit(1);
    if (backup && new RegExp(`^interface\\s+vlan\\s*${vlanId}\\s*$`, "im").test(backup.config)) {
      uses.push({ kind: "svi", detail: `it has a VLAN interface (interface Vlan${vlanId})` });
    }
    return uses;
  }

  /** Throws 409 when a VLAN that a push would delete from the switch is still in use there. */
  async assertDeletable(switchId: string, vlanId: number): Promise<void> {
    const uses = await this.usage(switchId, vlanId);
    if (uses.length) {
      throw new ConflictException(`VLAN ${vlanId} cannot be removed from the switch while it is in use: ${listUses(uses)}`);
    }
  }

  // ---- port validation ----

  /**
   * Throws 400 when a port is put in a VLAN the switch's wanted list does not have. Skipped until the list has been
   * taken from the switch (before the first poll everything would look undefined).
   */
  async assertDefined(switchId: string, vlanIds: number[], what: string): Promise<void> {
    const ids = vlanIds.filter((v) => v !== 1);
    if (ids.length === 0) return;
    const [sw] = await this.db.select({ at: ciscoSwitches.vlanBaselineAt }).from(ciscoSwitches).where(eq(ciscoSwitches.id, switchId)).limit(1);
    if (!sw?.at) return;
    const have = new Set(
      (await this.db.select({ v: ciscoVlans.vlanId }).from(ciscoVlans).where(eq(ciscoVlans.switchId, switchId))).map((r) => r.v),
    );
    const missing = ids.filter((v) => !have.has(v));
    if (missing.length) {
      throw new BadRequestException(`${what}: VLAN ${missing.join(", ")} is not defined on this switch. Add it on the VLANs page first.`);
    }
  }

  // ---- drift ----

  /**
   * Take the wanted list from the switch the first time (so a new install shows no drift), then compare wanted with
   * reported and keep the open VLAN drift events in step. Works from the last poll's VLAN data, so an edit shows up
   * at once without a new poll.
   */
  async detect(switchId: string): Promise<void> {
    const state = await this.ensureBaseline(switchId);
    if (!state) return; // unknown switch, or no VLAN data from it yet: nothing to compare against
    const { desired, observed } = state;

    const wanted = computeVlanDrift(desired, observed);
    const open = await this.db
      .select()
      .from(ciscoDriftEvents)
      .where(and(eq(ciscoDriftEvents.switchId, switchId), like(ciscoDriftEvents.portId, "vlan:%"), isNull(ciscoDriftEvents.resolvedAt)));
    const openByKey = new Map(open.map((o) => [`${o.portId}::${o.field}`, o]));

    const toInsert: Array<typeof ciscoDriftEvents.$inferInsert> = [];
    for (const w of wanted) {
      const k = `${vlanScope(w.vlanId)}::${w.field}`;
      const existing = openByKey.get(k);
      if (!existing) {
        toInsert.push({ switchId, portId: vlanScope(w.vlanId), field: w.field, expected: w.expected, observed: w.observed });
      } else {
        if (existing.expected !== w.expected || existing.observed !== w.observed) {
          await this.db.update(ciscoDriftEvents).set({ expected: w.expected, observed: w.observed }).where(eq(ciscoDriftEvents.id, existing.id));
        }
        openByKey.delete(k);
      }
    }
    const stale = [...openByKey.values()].map((o) => o.id);
    if (toInsert.length) await this.db.insert(ciscoDriftEvents).values(toInsert);
    if (stale.length) await this.db.update(ciscoDriftEvents).set({ resolvedAt: new Date() }).where(inArray(ciscoDriftEvents.id, stale));

    const [counted] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoDriftEvents)
      .where(and(eq(ciscoDriftEvents.switchId, switchId), isNull(ciscoDriftEvents.resolvedAt)));
    await this.db.update(ciscoSwitches).set({ configDrift: Number(counted?.n ?? 0) > 0 }).where(eq(ciscoSwitches.id, switchId));
  }

  /**
   * The first time a switch has VLAN data, take the wanted list from it (so a new install, or an upgrade, shows no
   * drift) and remember that it was done. Null while there is nothing to compare against.
   */
  private async ensureBaseline(
    switchId: string,
  ): Promise<{ desired: Array<{ vlanId: number; name: string }>; observed: Array<{ vlanId: number; vlanName: string | null }> } | null> {
    const [sw] = await this.db.select({ at: ciscoSwitches.vlanBaselineAt }).from(ciscoSwitches).where(eq(ciscoSwitches.id, switchId)).limit(1);
    if (!sw) return null;
    const observed = await this.db
      .select({ vlanId: ciscoVlanDb.vlanId, vlanName: ciscoVlanDb.vlanName })
      .from(ciscoVlanDb)
      .where(eq(ciscoVlanDb.switchId, switchId));
    let desired = await this.db.select({ vlanId: ciscoVlans.vlanId, name: ciscoVlans.name }).from(ciscoVlans).where(eq(ciscoVlans.switchId, switchId));
    // A switch always has VLAN 1, so no rows at all means no data yet (not "no VLANs"): do not compare.
    if (observed.length === 0) return null;
    if (!sw.at) {
      if (desired.length === 0) {
        const seed = observed
          .filter((o) => isManagedVlan(o.vlanId))
          .map((o) => ({ switchId, vlanId: o.vlanId, name: desiredNameFromObserved(o.vlanId, o.vlanName) }));
        if (seed.length) await this.db.insert(ciscoVlans).values(seed).onConflictDoNothing();
        desired = seed.map((r) => ({ vlanId: r.vlanId, name: r.name }));
      }
      await this.db.update(ciscoSwitches).set({ vlanBaselineAt: new Date() }).where(eq(ciscoSwitches.id, switchId));
    }
    return { desired, observed };
  }

  /** Forget the wanted list so the next poll takes it from the switch again (part of "re-import baseline"). */
  async resetBaseline(switchId: string): Promise<void> {
    await this.db.delete(ciscoVlans).where(eq(ciscoVlans.switchId, switchId));
    await this.db.update(ciscoSwitches).set({ vlanBaselineAt: null }).where(eq(ciscoSwitches.id, switchId));
  }

  /** Adopt what the switch has: a VLAN it has that is not wanted is added, one that is wanted but missing is dropped. */
  async accept(switchId: string, d: DriftRow): Promise<void> {
    const vlanId = parseVlanScope(d.portId);
    if (vlanId === null || !isManagedVlan(vlanId)) return;
    if (d.field === VLAN_FIELD_EXISTS) {
      if (d.observed === "1") {
        const [o] = await this.db
          .select({ vlanName: ciscoVlanDb.vlanName })
          .from(ciscoVlanDb)
          .where(and(eq(ciscoVlanDb.switchId, switchId), eq(ciscoVlanDb.vlanId, vlanId)))
          .limit(1);
        await this.db
          .insert(ciscoVlans)
          .values({ switchId, vlanId, name: desiredNameFromObserved(vlanId, o?.vlanName) })
          .onConflictDoNothing();
      } else {
        await this.db.delete(ciscoVlans).where(and(eq(ciscoVlans.switchId, switchId), eq(ciscoVlans.vlanId, vlanId)));
      }
    } else if (d.field === VLAN_FIELD_NAME) {
      await this.db
        .update(ciscoVlans)
        .set({ name: desiredNameFromObserved(vlanId, d.observed), updatedAt: new Date() })
        .where(and(eq(ciscoVlans.switchId, switchId), eq(ciscoVlans.vlanId, vlanId)));
    }
  }

  /** The wanted name of each VLAN on a switch, for a push that creates VLANs (the drift event only says "create"). */
  async desiredNames(switchId: string): Promise<Map<number, string>> {
    const rows = await this.db.select({ vlanId: ciscoVlans.vlanId, name: ciscoVlans.name }).from(ciscoVlans).where(eq(ciscoVlans.switchId, switchId));
    return new Map(rows.map((r) => [r.vlanId, effectiveVlanName(r.vlanId, r.name)]));
  }

  /** After a push went through, record the VLAN changes in the reported side so they are not seen as drift again. */
  async applyPushed(switchId: string, changes: PushChange[]): Promise<void> {
    const now = new Date();
    for (const c of changes) {
      const vlanId = parseVlanScope(c.portId);
      if (vlanId === null) continue;
      if (c.field === VLAN_FIELD_EXISTS && c.value === "1") {
        await this.db
          .insert(ciscoVlanDb)
          .values({ switchId, vlanId, vlanName: c.name ?? defaultVlanName(vlanId), vlanStatus: "active", polledAt: now })
          .onConflictDoUpdate({
            target: [ciscoVlanDb.switchId, ciscoVlanDb.vlanId],
            set: { vlanName: c.name ?? defaultVlanName(vlanId), vlanStatus: "active", polledAt: now },
          });
      } else if (c.field === VLAN_FIELD_EXISTS) {
        await this.db.delete(ciscoVlanDb).where(and(eq(ciscoVlanDb.switchId, switchId), eq(ciscoVlanDb.vlanId, vlanId)));
      } else if (c.field === VLAN_FIELD_NAME) {
        await this.db
          .update(ciscoVlanDb)
          .set({ vlanName: c.value ?? defaultVlanName(vlanId), polledAt: now })
          .where(and(eq(ciscoVlanDb.switchId, switchId), eq(ciscoVlanDb.vlanId, vlanId)));
      }
    }
  }

  // ---- helpers ----

  private assertManaged(vlanId: number): void {
    if (!isManagedVlan(vlanId)) {
      throw new BadRequestException("VLAN 1 and VLANs 1002-1005 exist on every switch and cannot be added, renamed or removed");
    }
  }

  private async requireSwitch(switchId: string): Promise<void> {
    const [sw] = await this.db.select({ id: ciscoSwitches.id }).from(ciscoSwitches).where(eq(ciscoSwitches.id, switchId)).limit(1);
    if (!sw) throw new NotFoundException("Switch not found");
  }

  private async switchesById(ids: string[]): Promise<Map<string, { id: string; hostname: string }>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select({ id: ciscoSwitches.id, hostname: ciscoSwitches.hostname }).from(ciscoSwitches).where(inArray(ciscoSwitches.id, unique));
    return new Map(rows.map((r) => [r.id, r]));
  }
}
