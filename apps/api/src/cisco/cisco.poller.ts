import { Injectable, Logger, type OnModuleInit, Inject } from "@nestjs/common";
import { and, eq, inArray, isNull, desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
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
import { decryptStoredSecret } from "../settings/crypto";
import { NotificationsService } from "../notifications/notifications.service";
import { InfraService } from "../infra/infra.service";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { normalizePrefs } from "./cisco.service";
import { sshShell, stripAnsi } from "./ssh";
import {
  detectOS,
  parseInterfacesStatus,
  parseRunningConfig,
  extractRunningConfig,
  parseModel,
  parseMacTable,
  parseArp,
  parseVlans,
  parseNeighbors,
  type CiscoOs,
  type CfgPort,
} from "./parsers";

const POLL_SEC = Math.max(30, parseInt(process.env.CISCO_POLL_SEC ?? "300", 10));
const SSH_TIMEOUT_MS = Math.max(5, parseInt(process.env.CISCO_SSH_TIMEOUT_SEC ?? "15", 10)) * 1000;
const CONCURRENCY = 4;
const BACKUP_RETENTION = 30;

type SwitchRow = typeof ciscoSwitches.$inferSelect;

/** Desired-vs-observed field set per port, gated by mode (mirrors the source). */
function driftFieldsFor(desired: typeof ciscoPorts.$inferSelect, obs: CfgPort): Array<[string, string, string]> {
  const pairs: Array<[string, string, string]> = [
    ["admin_enabled", desired.adminEnabled ? "1" : "0", obs.adminEnabled ? "1" : "0"],
  ];
  if (desired.hasSwitchport && obs.hasSwitchport) {
    pairs.push(["mode", desired.mode, obs.mode]);
    if (desired.mode === "access" && obs.mode === "access") {
      pairs.push(["access_vlan", String(desired.accessVlan), String(obs.accessVlan)]);
    }
    if (desired.mode === "trunk" && obs.mode === "trunk") {
      pairs.push(["trunk_native_vlan", String(desired.trunkNativeVlan), String(obs.trunkNativeVlan)]);
      pairs.push(["trunk_allowed_vlans", desired.trunkAllowedVlans, obs.trunkAllowedVlans]);
    }
  }
  return pairs;
}

const norm = (v: string | null | undefined) => String(v ?? "").toLowerCase().trim();

/** Rough seconds from a Cisco uptime string ("12 weeks, 3 days, 4 hours"). 0 if unparseable. */
function uptimeToSec(s: string | null | undefined): number {
  if (!s) return 0;
  const units: Array<[RegExp, number]> = [
    [/(\d+)\s*year/i, 31_536_000],
    [/(\d+)\s*week/i, 604_800],
    [/(\d+)\s*day/i, 86_400],
    [/(\d+)\s*hour/i, 3_600],
    [/(\d+)\s*min/i, 60],
  ];
  let sec = 0;
  for (const [re, mul] of units) {
    const m = re.exec(s);
    if (m) sec += Number(m[1]) * mul;
  }
  return sec;
}

@Injectable()
export class CiscoPoller implements OnModuleInit {
  private readonly logger = new Logger(CiscoPoller.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly notifications: NotificationsService,
    private readonly infra: InfraService,
    private readonly settings: SettingsService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    // A cluster job: one node polls the switches at a time. Waits POLL_SEC after
    // each pass finishes, like the self-rescheduling timer it replaces.
    this.jobs.register({
      name: "cisco-poll",
      everyMs: POLL_SEC * 1000,
      initialDelayMs: 10_000,
      schedule: "fixed-delay",
      run: () => this.pollAll(),
    });
    this.logger.log(`Cisco poller scheduling every ${POLL_SEC}s`);
  }

  async pollAll(): Promise<void> {
    const rows = await this.db.select().from(ciscoSwitches);
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, rows.length) }, async () => {
      while (idx < rows.length) {
        const sw = rows[idx++]!;
        if (this.inFlight.has(sw.id)) continue;
        this.inFlight.add(sw.id);
        try {
          await this.pollSwitch(sw);
        } catch (err) {
          this.logger.warn(`poll ${sw.hostname}: ${(err as Error).message}`);
        } finally {
          this.inFlight.delete(sw.id);
        }
      }
    });
    await Promise.all(workers);
  }

  conn(sw: SwitchRow) {
    return {
      host: sw.ipAddress,
      port: 22,
      username: sw.username,
      password: sw.passwordEnc ? decryptStoredSecret(sw.passwordEnc, "SSH password") : "",
      timeoutMs: SSH_TIMEOUT_MS,
    };
  }

  async pollSwitchById(id: string): Promise<void> {
    const [sw] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, id)).limit(1);
    if (sw) await this.pollSwitch(sw);
  }

  /** Force a full running-config snapshot saved as a `manual` backup. */
  async triggerManualBackup(id: string): Promise<void> {
    const [sw] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, id)).limit(1);
    if (!sw) return;
    const cfg = this.conn(sw);
    const versionRaw = await sshShell(cfg, ["show version"]);
    const os = detectOS(versionRaw);
    const runCmd = os === "nxos" ? "show run all" : "show running-config";
    const raw = await sshShell(cfg, [runCmd]);
    await this.saveBackup(id, extractRunningConfig(raw, os), "manual");
  }

  async pollSwitch(sw: SwitchRow): Promise<void> {
    let cfg: ReturnType<CiscoPoller["conn"]>;
    try {
      cfg = this.conn(sw);
    } catch (err) {
      return this.markUnreachable(sw, (err as Error).message);
    }
    const wasReachable = sw.reachable;
    const firstPoll = sw.lastPolledAt === null;
    const oldUptimeSec = uptimeToSec(sw.uptime);
    let os: CiscoOs = "ios";
    let versionRaw = "";
    try {
      versionRaw = await sshShell(cfg, ["show version"]);
      os = detectOS(versionRaw);
    } catch (err) {
      return this.markUnreachable(sw, (err as Error).message);
    }

    const ifStatusCmd = os === "nxos" ? "show interface status" : "show interfaces status";
    const runCmd = os === "nxos" ? "show run all" : "show running-config";

    // ---- core: interfaces status + running-config + inventory ----
    let combined = "";
    try {
      combined = await sshShell(cfg, [ifStatusCmd, runCmd, "show inventory"]);
    } catch (err) {
      return this.markUnreachable(sw, (err as Error).message);
    }

    const live = parseInterfacesStatus(combined);
    const parsed = parseRunningConfig(combined);
    const model = parseModel(combined);
    const uptime = /uptime is (.+)/i.exec(stripAnsi(versionRaw))?.[1]?.trim() ?? sw.uptime ?? "—";

    const now = new Date();

    // Snapshot the previous live oper state (for port-change alerting) before
    // we overwrite it.
    const oldLive = new Map(
      (
        await this.db
          .select({ portId: ciscoPortLiveState.portId, operStatus: ciscoPortLiveState.operStatus })
          .from(ciscoPortLiveState)
          .where(eq(ciscoPortLiveState.switchId, sw.id))
      ).map((r) => [r.portId, r.operStatus]),
    );

    // Live oper state (dashboard up/down).
    if (live.length) {
      await this.db.delete(ciscoPortLiveState).where(eq(ciscoPortLiveState.switchId, sw.id));
      await this.db.insert(ciscoPortLiveState).values(
        live.map((l) => ({
          switchId: sw.id,
          portId: l.portId,
          operStatus: l.operStatus,
          mode: l.mode,
          accessVlan: l.accessVlan,
          polledAt: now,
        })),
      );
    }

    // Seed desired ports on first contact; otherwise run drift.
    const existingCount = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoPorts)
      .where(eq(ciscoPorts.switchId, sw.id));
    if (Number(existingCount[0]?.n ?? 0) === 0 && parsed.ports.length) {
      await this.seedPorts(sw.id, parsed.ports);
    } else {
      await this.detectPortDrift(sw.id, parsed.ports);
    }
    await this.detectDeviceDrift(sw, { hostname: parsed.hostname, snmpLocation: parsed.snmpLocation, model });

    // Config backup (incremental — skipped when unchanged).
    const configChanged = await this.saveBackup(sw.id, extractRunningConfig(combined, os), "incremental");

    // ---- neighbors (for uplink exclusion) ----
    try {
      const neighCmds =
        os === "nxos"
          ? ["show lldp neighbors detail"]
          : ["show lldp neighbors detail", "show cdp neighbors detail"];
      const nraw = await sshShell(cfg, neighCmds);
      const neighbors = [
        ...parseNeighbors(nraw, "lldp"),
        ...(os === "nxos" ? [] : parseNeighbors(nraw, "cdp")),
      ];
      await this.saveNeighbors(sw.id, neighbors, now);
    } catch (err) {
      this.logger.debug(`neighbors ${sw.hostname}: ${(err as Error).message}`);
    }

    // ---- L2: mac / arp / vlan ----
    try {
      const l2raw = await sshShell(cfg, ["show mac address-table", "show ip arp", "show vlan brief"]);
      await this.saveL2(sw.id, l2raw, os, now);
    } catch (err) {
      this.logger.debug(`l2 ${sw.hostname}: ${(err as Error).message}`);
    }

    const openDrift = await this.openDriftCount(sw.id);
    await this.db
      .update(ciscoSwitches)
      .set({
        reachable: true,
        lastError: null,
        uptime,
        model: model ?? sw.model,
        lastPolledAt: now,
        configDrift: openDrift > 0,
        updatedAt: now,
      })
      .where(eq(ciscoSwitches.id, sw.id));

    // ---- alerting (transitions only; first poll just establishes a baseline) ----
    const newUptimeSec = uptimeToSec(uptime);
    const rebooted = oldUptimeSec > 0 && newUptimeSec > 0 && newUptimeSec < oldUptimeSec;
    const portChanges: string[] = [];
    if (!firstPoll && oldLive.size > 0) {
      for (const l of live) {
        const prev = oldLive.get(l.portId);
        if (prev !== undefined && prev !== null && (prev === "up") !== (l.operStatus === "up")) {
          portChanges.push(`${l.portId} ${l.operStatus === "up" ? "up" : "down"}`);
        }
      }
    }
    if (!firstPoll) {
      await this.evaluateAlerts(sw, { cameOnline: !wasReachable, portChanges, configChanged, rebooted, uptime });
    }
  }

  // ---- alerting ----

  /** Recipients that should receive monitoring notifications (reuses infra logic). */
  private async fanOut(sw: SwitchRow, kind: string, title: string, body: string): Promise<void> {
    try {
      // Global maintenance mode silences the notification fan-out (all Cisco
      // alert kinds route through here); drift/state tracking still happens.
      if ((await this.settings.get("monitoring.maintenance_mode")) === true) return;
      const recipients = await this.infra.monitoringRecipientIds();
      if (!recipients.length) return;
      await this.notifications.createMany(
        recipients.map((id) => ({
          recipientUserId: id,
          kind,
          title,
          body,
          link: `/monitoring/network-cisco/switches/${sw.id}`,
        })),
      );
    } catch (err) {
      this.logger.warn(`cisco alert fan-out failed: ${(err as Error).message}`);
    }
  }

  private async markUnreachable(sw: SwitchRow, msg: string): Promise<void> {
    await this.db
      .update(ciscoSwitches)
      .set({ reachable: false, lastError: msg, lastPolledAt: new Date(), updatedAt: new Date() })
      .where(eq(ciscoSwitches.id, sw.id));
    // Alert only on the transition into offline (not repeated while down).
    if (sw.reachable && normalizePrefs(sw.alertPrefs).deviceOffline) {
      await this.fanOut(sw, "cisco.device_offline", `${sw.hostname} is offline`, `SSH poll failed: ${msg}`);
    }
  }

  private async evaluateAlerts(
    sw: SwitchRow,
    ev: { cameOnline: boolean; portChanges: string[]; configChanged: boolean; rebooted: boolean; uptime: string },
  ): Promise<void> {
    const prefs = normalizePrefs(sw.alertPrefs);
    const jobs: Promise<void>[] = [];
    if (ev.cameOnline && prefs.deviceOffline) {
      jobs.push(this.fanOut(sw, "cisco.device_offline", `${sw.hostname} is back online`, "The switch is reachable again."));
    }
    // Only alert on port up/down when port-state monitoring is enabled for the
    // switch. `checkPortState` is the master toggle for the whole port-state
    // feature (it already gates the degraded health badge), so with it off the
    // portStateChange alert pref must stay inert rather than firing on churn.
    if (ev.portChanges.length && sw.checkPortState && prefs.portStateChange) {
      jobs.push(
        this.fanOut(
          sw,
          "cisco.port_change",
          `${sw.hostname}: ${ev.portChanges.length} port state change${ev.portChanges.length === 1 ? "" : "s"}`,
          ev.portChanges.slice(0, 25).join(", "),
        ),
      );
    }
    if (ev.configChanged && prefs.configChange) {
      jobs.push(this.fanOut(sw, "cisco.config_change", `${sw.hostname} config changed`, "A new running-config backup was captured."));
    }
    if (ev.rebooted && prefs.uptimeChange) {
      jobs.push(this.fanOut(sw, "cisco.uptime_change", `${sw.hostname} rebooted`, `Uptime reset — now up ${ev.uptime}.`));
    }
    await Promise.all(jobs);
  }

  /** Seed the desired-config `ports` table from a first successful poll. */
  private async seedPorts(switchId: string, ports: CfgPort[]): Promise<void> {
    await this.db.insert(ciscoPorts).values(
      ports.map((p) => ({
        switchId,
        portId: p.portId,
        description: p.description,
        adminEnabled: p.adminEnabled,
        speed: p.speed,
        duplex: p.duplex,
        mode: p.mode,
        hasSwitchport: p.hasSwitchport,
        accessVlan: p.accessVlan,
        trunkNativeVlan: p.trunkNativeVlan,
        trunkAllowedVlans: p.trunkAllowedVlans,
      })),
    );
  }

  /** Import ports on add — seeds the desired baseline only when empty. */
  async importPorts(id: string): Promise<{ imported: number }> {
    const [sw] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, id)).limit(1);
    if (!sw) return { imported: 0 };
    await this.pollSwitch(sw);
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoPorts)
      .where(eq(ciscoPorts.switchId, id));
    return { imported: Number(n) };
  }

  /** Force a fresh baseline: clear desired ports + open drift, then re-seed. */
  async reimportPorts(id: string): Promise<{ imported: number }> {
    await this.db.delete(ciscoPorts).where(eq(ciscoPorts.switchId, id));
    await this.db
      .update(ciscoDriftEvents)
      .set({ resolvedAt: new Date() })
      .where(and(eq(ciscoDriftEvents.switchId, id), isNull(ciscoDriftEvents.resolvedAt)));
    return this.importPorts(id);
  }

  private async detectDeviceDrift(
    sw: SwitchRow,
    live: { hostname: string | null; snmpLocation: string | null; model: string | null },
  ): Promise<void> {
    const checks: Array<{ field: string; expected: string | null; observed: string | null }> = [
      { field: "hostname", expected: sw.hostname, observed: live.hostname },
      { field: "location", expected: sw.location, observed: live.snmpLocation },
      { field: "model", expected: sw.model, observed: live.model },
    ];
    const open = await this.db
      .select()
      .from(ciscoDriftEvents)
      .where(
        and(
          eq(ciscoDriftEvents.switchId, sw.id),
          eq(ciscoDriftEvents.portId, "__device__"),
          isNull(ciscoDriftEvents.resolvedAt),
        ),
      );
    const openByField = new Map(open.map((o) => [o.field, o]));
    for (const c of checks) {
      if (c.observed === null || c.observed === undefined) continue; // not seen this poll
      const mismatch = norm(c.expected) !== norm(c.observed);
      const existing = openByField.get(c.field);
      if (mismatch && !existing) {
        await this.db.insert(ciscoDriftEvents).values({
          switchId: sw.id,
          portId: "__device__",
          field: c.field,
          expected: c.expected,
          observed: c.observed,
        });
      } else if (!mismatch && existing) {
        await this.db
          .update(ciscoDriftEvents)
          .set({ resolvedAt: new Date() })
          .where(eq(ciscoDriftEvents.id, existing.id));
      }
    }
  }

  private async detectPortDrift(switchId: string, cfgPorts: CfgPort[]): Promise<void> {
    const desired = await this.db.select().from(ciscoPorts).where(eq(ciscoPorts.switchId, switchId));
    const open = await this.db
      .select()
      .from(ciscoDriftEvents)
      .where(
        and(
          eq(ciscoDriftEvents.switchId, switchId),
          sql`${ciscoDriftEvents.portId} <> '__device__'`,
          isNull(ciscoDriftEvents.resolvedAt),
        ),
      );
    const obsByPort = new Map(cfgPorts.map((p) => [p.portId, p]));
    const openByKey = new Map(open.map((o) => [`${o.portId}::${o.field}`, o]));

    const toInsert: Array<typeof ciscoDriftEvents.$inferInsert> = [];
    const toResolve: string[] = [];

    for (const d of desired) {
      const obs = obsByPort.get(d.portId);
      if (!obs) continue; // port no longer in running config — skip (not a field drift)
      for (const [field, expected, observed] of driftFieldsFor(d, obs)) {
        const key = `${d.portId}::${field}`;
        const existing = openByKey.get(key);
        const mismatch = norm(expected) !== norm(observed);
        if (mismatch && !existing) {
          toInsert.push({ switchId, portId: d.portId, field, expected, observed });
        } else if (!mismatch && existing) {
          toResolve.push(existing.id);
        }
        openByKey.delete(key);
      }
    }
    if (toInsert.length) await this.db.insert(ciscoDriftEvents).values(toInsert);
    if (toResolve.length) {
      await this.db
        .update(ciscoDriftEvents)
        .set({ resolvedAt: new Date() })
        .where(inArray(ciscoDriftEvents.id, toResolve));
    }
  }

  private async openDriftCount(switchId: string): Promise<number> {
    const [{ n } = { n: 0 }] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(ciscoDriftEvents)
      .where(and(eq(ciscoDriftEvents.switchId, switchId), isNull(ciscoDriftEvents.resolvedAt)));
    return Number(n);
  }

  // ---- backups ----

  private normalizeConfig(raw: string): string {
    const VOLATILE = [
      /^Last configuration change at/i,
      /^NVRAM config last updated/i,
      /^Building configuration/i,
      /^Current configuration/i,
      /^!Time:/i,
      /^!Running configuration last done at:/i,
      /^ntp clock-period/i,
    ];
    return stripAnsi(raw)
      .split("\n")
      .map((l) => l.replace(/\r$/, ""))
      .filter((l) => {
        const t = l.trim();
        if (t === "") return true;
        if (t.startsWith("!")) return false;
        if (/^[A-Za-z0-9][\w.-]*#\s*/.test(t)) return false; // prompt echoes
        return !VOLATILE.some((re) => re.test(t));
      })
      .join("\n")
      .trim();
  }

  async saveBackup(switchId: string, rawConfig: string, type: "incremental" | "full" | "manual"): Promise<boolean> {
    const normalized = this.normalizeConfig(rawConfig);
    if (!normalized || normalized.length < 20) return false; // nothing useful captured
    const checksum = createHash("sha256").update(normalized).digest("hex");
    if (type === "incremental") {
      const [latest] = await this.db
        .select({ checksum: ciscoConfigBackups.checksum })
        .from(ciscoConfigBackups)
        .where(eq(ciscoConfigBackups.switchId, switchId))
        .orderBy(desc(ciscoConfigBackups.backedUpAt))
        .limit(1);
      if (latest?.checksum === checksum) return false; // unchanged
    }
    await this.db.insert(ciscoConfigBackups).values({ switchId, configText: normalized, checksum, backupType: type });
    // Prune to retention.
    const keep = await this.db
      .select({ id: ciscoConfigBackups.id })
      .from(ciscoConfigBackups)
      .where(eq(ciscoConfigBackups.switchId, switchId))
      .orderBy(desc(ciscoConfigBackups.backedUpAt))
      .limit(BACKUP_RETENTION);
    if (keep.length === BACKUP_RETENTION) {
      const keepIds = keep.map((k) => k.id);
      await this.db
        .delete(ciscoConfigBackups)
        .where(and(eq(ciscoConfigBackups.switchId, switchId), sql`${ciscoConfigBackups.id} <> ALL(${keepIds})`));
    }
    return true;
  }

  // ---- neighbors + L2 ----

  private async saveNeighbors(
    switchId: string,
    neighbors: ReturnType<typeof parseNeighbors>,
    now: Date,
  ): Promise<void> {
    await this.db.delete(ciscoNeighbors).where(eq(ciscoNeighbors.switchId, switchId));
    if (neighbors.length) {
      // Dedup on (localPort, hostname) — lldp + cdp can both list a neighbor.
      const seen = new Set<string>();
      const rows = neighbors.filter((n) => {
        const k = `${n.localPort}|${n.neighborHostname}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      await this.db.insert(ciscoNeighbors).values(
        rows.map((n) => ({
          switchId,
          localPort: n.localPort,
          neighborHostname: n.neighborHostname,
          neighborIp: n.neighborIp,
          neighborPort: n.neighborPort,
          protocol: n.protocol,
          polledAt: now,
        })),
      );
    }
  }

  private async saveL2(switchId: string, raw: string, os: CiscoOs, now: Date): Promise<void> {
    const macs = parseMacTable(raw, os);
    const arps = parseArp(raw, os);
    const vlans = parseVlans(raw);

    await this.db.delete(ciscoMacTable).where(eq(ciscoMacTable.switchId, switchId));
    if (macs.length) {
      // Dedup on (mac, vlan) to satisfy the unique constraint.
      const seen = new Set<string>();
      const rows = macs.filter((m) => {
        const k = `${m.macAddress}|${m.vlan}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      await this.db.insert(ciscoMacTable).values(
        rows.map((m) => ({
          switchId,
          macAddress: m.macAddress,
          vlan: m.vlan,
          portId: m.portId,
          macType: m.macType,
          polledAt: now,
        })),
      );
    }

    await this.db.delete(ciscoArpCache).where(eq(ciscoArpCache.switchId, switchId));
    if (arps.length) {
      const seen = new Set<string>();
      const rows = arps.filter((a) => {
        if (seen.has(a.ipAddress)) return false;
        seen.add(a.ipAddress);
        return true;
      });
      await this.db.insert(ciscoArpCache).values(
        rows.map((a) => ({
          switchId,
          ipAddress: a.ipAddress,
          macAddress: a.macAddress,
          interface: a.interface,
          vlan: null,
          vrf: a.vrf,
          polledAt: now,
        })),
      );
    }

    await this.db.delete(ciscoVlanDb).where(eq(ciscoVlanDb.switchId, switchId));
    if (vlans.length) {
      await this.db.insert(ciscoVlanDb).values(
        vlans.map((v) => ({
          switchId,
          vlanId: v.vlanId,
          vlanName: v.vlanName,
          vlanStatus: v.vlanStatus,
          polledAt: now,
        })),
      );
    }
  }

  // ---- drift push (write desired to the device over SSH) ----

  private readonly SPEED_TO_IOS: Record<string, string> = {
    "10M": "10",
    "100M": "100",
    "1G": "1000",
    "10G": "10000",
    "25G": "25000",
    "40G": "40000",
    "100G": "100000",
  };

  async pushToSwitch(
    id: string,
    changes: Array<{ portId: string; field: string; value: string | null }>,
  ): Promise<void> {
    const [sw] = await this.db.select().from(ciscoSwitches).where(eq(ciscoSwitches.id, id)).limit(1);
    if (!sw) throw new Error("switch not found");
    const cmds: string[] = ["configure terminal"];
    const byPort = new Map<string, Array<{ field: string; value: string | null }>>();
    for (const c of changes) {
      if (c.portId === "__device__") {
        if (c.field === "hostname" && c.value) cmds.push(`hostname ${c.value}`);
        if (c.field === "location" && c.value) cmds.push(`snmp-server location ${c.value}`);
        continue;
      }
      if (!byPort.has(c.portId)) byPort.set(c.portId, []);
      byPort.get(c.portId)!.push({ field: c.field, value: c.value });
    }
    for (const [portId, fields] of byPort) {
      cmds.push(`interface ${portId}`);
      for (const f of fields) {
        switch (f.field) {
          case "admin_enabled":
            cmds.push(f.value === "1" || f.value === "true" ? "no shutdown" : "shutdown");
            break;
          case "description":
            cmds.push(f.value ? `description ${f.value}` : "no description");
            break;
          case "access_vlan":
            if (f.value) cmds.push(`switchport access vlan ${f.value}`);
            break;
          case "trunk_native_vlan":
            if (f.value) cmds.push(`switchport trunk native vlan ${f.value}`);
            break;
          case "trunk_allowed_vlans":
            if (f.value) cmds.push(`switchport trunk allowed vlan ${f.value}`);
            break;
          case "mode":
            if (f.value) cmds.push(`switchport mode ${f.value}`);
            break;
          case "speed":
            if (f.value) cmds.push(`speed ${this.SPEED_TO_IOS[f.value] ?? f.value}`);
            break;
          case "duplex":
            if (f.value) cmds.push(`duplex ${f.value}`);
            break;
          default:
            break;
        }
      }
      cmds.push("exit");
    }
    cmds.push("end", "write memory");
    await sshShell(this.conn(sw), cmds);
  }
}
