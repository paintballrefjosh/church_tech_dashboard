import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import {
  PERMISSIONS,
  agoText,
  average,
  dnsLevel,
  durationText,
  formatLatency,
  formatPercent,
  internetLevel,
  median,
  sectionOff,
  sectionOk,
  serversLevel,
  switchesLevel,
  wifiLevel,
  type AreaKey,
  type Section,
  type SystemMeters,
} from "@church/shared";
import { DB, type Db } from "../../../db/db.module";
import { ciscoDriftEvents, ciscoPortLiveState } from "../../../db/schema/cisco";
import { infraMetricSamples, infraTargets } from "../../../db/schema/infra";
import { monitorChecks, monitorIncidents, monitors } from "../../../db/schema/monitors";
import { UnifiService } from "../../../unifi/unifi.service";
import { DnsService } from "../../../dns/dns.service";
import { DnsSyncService } from "../../../dns/dns.sync";
import type { HomeContext, SectionBuilder } from "../home.types";
import { TtlCache, withDeadline } from "../cache";

type Channel = SystemMeters["channels"][number];
type Alert = SystemMeters["recentAlerts"][number];

/** Meters are refreshed with the page (every 15 s); the controller and DNS server are asked less often. */
export const METERS_UNIFI_CACHE_MS = 15_000;
export const METERS_DNS_CACHE_MS = 60_000;
/** Each channel gets less than the section's own 2.5 s, so one slow source leaves the others standing. */
export const METERS_DEADLINE_MS = 2_200;
/** A host's reading counts only if it is this fresh. */
export const SERVERS_SAMPLE_WINDOW_MS = 5 * 60_000;
export const DRIFT_WINDOW_MS = 24 * 3_600_000;
export const MAX_ALERTS = 5;
const UNAVAILABLE = "unavailable";

interface UnifiDeviceRow {
  name?: string;
  model?: string;
  mac?: string;
  state?: number;
  last_seen?: number;
}

function off(area: AreaKey, labels: readonly string[]): Channel {
  return { area, level: null, readings: labels.map((label) => ({ label, value: UNAVAILABLE })) };
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/**
 * One honest reading per channel for the Front of House console. Each channel is read on its own
 * and fails on its own: `level: null` and the word "unavailable", never a made-up number.
 * Scales (see packages/shared/src/dashboard/meters.ts): servers = average CPU / 100, internet =
 * median latency / 200 ms, Wi-Fi = clients / 250, switches = ports up / ports known, DNS =
 * queries per minute / 1000. All are capped at 1.
 */
@Injectable()
export class HomeMetersSection implements SectionBuilder<SystemMeters> {
  private readonly cache = new TtlCache();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly unifi: UnifiService,
    private readonly dns: DnsService,
    private readonly dnsSync: DnsSyncService,
  ) {}

  async build(ctx: HomeContext): Promise<Section<SystemMeters>> {
    const perms = ctx.user.permissions;
    if (!perms.includes(PERMISSIONS.MONITORS_READ_ANY)) return sectionOff("forbidden");
    const canUnifi = perms.includes(PERMISSIONS.UNIFI_READ_ANY);

    const guard = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await withDeadline(run(), METERS_DEADLINE_MS, "timed out");
      } catch {
        return fallback;
      }
    };

    const [servers, internet, wifi, switches, dns, incidents] = await Promise.all([
      guard(() => this.servers(), off("servers", ["avg CPU", "memory"])),
      guard(() => this.internet(), off("internet", ["latency", "monitors"])),
      canUnifi
        ? guard(() => this.wifi(), { channel: off("wifi", ["clients", "devices online"]), offline: [] })
        : Promise.resolve(null),
      guard(() => this.switches(ctx.now), off("switches", ["ports up", "config drift"])),
      guard(() => this.dnsChannel(ctx.now), off("dns", ["queries/min", "sync"])),
      guard(() => this.incidents(), [] as Alert[]),
    ]);

    const channels: Channel[] = [servers, internet];
    if (wifi) channels.push(wifi.channel);
    channels.push(switches, dns);

    const unifiAlerts: Alert[] = (wifi?.offline ?? []).map((d, i) => ({
      at:
        typeof d.last_seen === "number" && d.last_seen > 0
          ? new Date(d.last_seen * 1000).toISOString()
          : ctx.now.toISOString(),
      title: `${d.name || d.model || d.mac || `UniFi device ${i + 1}`} offline`,
      href: "/monitoring/network",
    }));
    const recentAlerts = [...incidents, ...unifiAlerts]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_ALERTS);

    return sectionOk({ channels, recentAlerts });
  }

  /** Latest target-level sample per enabled host within 5 minutes; averages of CPU and memory. */
  private async servers(): Promise<Channel> {
    const cutoff = new Date(Date.now() - SERVERS_SAMPLE_WINDOW_MS);
    const rows = await this.db
      .select({
        targetId: infraMetricSamples.targetId,
        ts: infraMetricSamples.ts,
        cpu: infraMetricSamples.cpuPct,
        mem: infraMetricSamples.memPct,
      })
      .from(infraMetricSamples)
      .innerJoin(infraTargets, eq(infraTargets.id, infraMetricSamples.targetId))
      .where(
        and(
          eq(infraTargets.enabled, true),
          eq(infraMetricSamples.entityKind, "target"),
          eq(infraMetricSamples.entityId, ""),
          gte(infraMetricSamples.ts, cutoff),
        ),
      );
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = latest.get(r.targetId);
      if (!prev || r.ts > prev.ts) latest.set(r.targetId, r);
    }
    const cpu = [...latest.values()].flatMap((r) => (r.cpu === null ? [] : [num(r.cpu)]));
    const mem = [...latest.values()].flatMap((r) => (r.mem === null ? [] : [num(r.mem)]));
    const avgCpu = average(cpu);
    const avgMem = average(mem);
    return {
      area: "servers",
      level: serversLevel(avgCpu),
      readings: [
        { label: "avg CPU", value: formatPercent(avgCpu) },
        { label: "memory", value: formatPercent(avgMem) },
      ],
    };
  }

  /** Median latency of the latest check of each enabled http/icmp monitor that answered. */
  private async internet(): Promise<Channel> {
    const rows = await this.db
      .select({ id: monitors.id })
      .from(monitors)
      .where(and(eq(monitors.enabled, true), inArray(monitors.kind, ["http", "icmp"])));
    const latest = await Promise.all(
      rows.map(async (m) => {
        const [c] = await this.db
          .select({ ok: monitorChecks.ok, ms: monitorChecks.latencyMs })
          .from(monitorChecks)
          .where(eq(monitorChecks.monitorId, m.id))
          .orderBy(desc(monitorChecks.ts))
          .limit(1);
        return c && c.ok && c.ms !== null ? num(c.ms) : null;
      }),
    );
    const values = latest.flatMap((v) => (v === null ? [] : [v]));
    const med = median(values);
    return {
      area: "internet",
      level: internetLevel(med),
      readings: [
        { label: "latency", value: formatLatency(med) },
        { label: "monitors", value: values.length === 0 ? UNAVAILABLE : `${values.length} of ${rows.length} answering` },
      ],
    };
  }

  /** Clients and devices online from the cached controller summary; offline devices feed the alert log. */
  private async wifi(): Promise<{ channel: Channel; offline: UnifiDeviceRow[] }> {
    const data = await this.cache.get("unifi", METERS_UNIFI_CACHE_MS, async () => {
      const summary = await this.unifi.summary();
      const offline: UnifiDeviceRow[] =
        summary.configured && summary.reachable && summary.devices.offline > 0
          ? ((await this.unifi.devices()) as UnifiDeviceRow[]).filter((d) => d.state !== 1)
          : [];
      return { summary, offline };
    });
    const s = data.summary;
    if (!s.configured || !s.reachable) return { channel: off("wifi", ["clients", "devices online"]), offline: [] };
    return {
      channel: {
        area: "wifi",
        level: wifiLevel(s.clients.total),
        readings: [
          { label: "clients", value: String(s.clients.total) },
          { label: "devices online", value: `${s.devices.online} of ${s.devices.total}` },
        ],
      },
      offline: data.offline,
    };
  }

  /** Ports up over ports known (last poll), and drift events detected in the last 24 hours. */
  private async switches(now: Date): Promise<Channel> {
    const since = new Date(now.getTime() - DRIFT_WINDOW_MS);
    const [[ports], [drift]] = await Promise.all([
      this.db
        .select({
          total: sql<string>`count(*)`,
          up: sql<string>`count(*) filter (where ${ciscoPortLiveState.operStatus} = 'up')`,
        })
        .from(ciscoPortLiveState),
      this.db
        .select({ n: sql<string>`count(*)` })
        .from(ciscoDriftEvents)
        .where(gte(ciscoDriftEvents.detectedAt, since)),
    ]);
    const total = num(ports?.total);
    const up = num(ports?.up);
    const driftCount = num(drift?.n);
    return {
      area: "switches",
      level: switchesLevel(up, total),
      readings: [
        { label: "ports up", value: total === 0 ? UNAVAILABLE : String(up) },
        { label: "config drift", value: driftCount === 0 ? "none in 24 h" : `${driftCount} in 24 h` },
      ],
    };
  }

  /** Queries per minute over the last hour (cached 60 s), and when the IPAM-to-DNS sync last ran. */
  private async dnsChannel(now: Date): Promise<Channel> {
    const [stats, status] = await Promise.all([
      this.cache.get("dns-stats", METERS_DNS_CACHE_MS, () => this.dns.stats("LastHour")),
      this.dnsSync.status().catch(() => null),
    ]);
    const qpm = Math.round(stats.totals.queries / 60);
    const run = status?.lastRun ?? null;
    const when = run ? new Date(run.finishedAt ?? run.startedAt) : null;
    return {
      area: "dns",
      level: dnsLevel(qpm),
      readings: [
        { label: "queries/min", value: String(qpm) },
        { label: "sync", value: status === null ? UNAVAILABLE : agoText(when, now) },
      ],
    };
  }

  /** The newest incidents (open or resolved) of monitors and hosts, worded in plain sentences. */
  private async incidents(): Promise<Alert[]> {
    const rows = await this.db
      .select({
        id: monitorIncidents.id,
        monitorId: monitorIncidents.monitorId,
        targetId: monitorIncidents.targetId,
        startedAt: monitorIncidents.startedAt,
        resolvedAt: monitorIncidents.resolvedAt,
        reason: monitorIncidents.reason,
        ruleId: monitorIncidents.ruleId,
        monitorName: monitors.name,
        targetName: infraTargets.name,
      })
      .from(monitorIncidents)
      .leftJoin(monitors, eq(monitors.id, monitorIncidents.monitorId))
      .leftJoin(infraTargets, eq(infraTargets.id, monitorIncidents.targetId))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(MAX_ALERTS);
    return rows.map((r) => {
      const name = r.monitorName ?? r.targetName ?? "A system";
      const what = r.ruleId ? "crossed an alert threshold" : "was down";
      const title = r.resolvedAt
        ? `${name} ${what}, back to normal after ${durationText(r.resolvedAt.getTime() - r.startedAt.getTime())}`
        : r.ruleId
          ? `${name} crossed an alert threshold`
          : r.reason
          ? `${name} is down: ${r.reason}`
          : `${name} is down`;
      const href = r.monitorId ? `/monitoring/${r.monitorId}` : r.targetId ? `/monitoring/infra/${r.targetId}` : null;
      return { at: r.startedAt.toISOString(), title, href };
    });
  }
}
