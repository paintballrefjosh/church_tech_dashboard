import { Injectable } from "@nestjs/common";
import {
  PERMISSIONS,
  sectionOff,
  sectionOk,
  type AreaKey,
  type Section,
  type SystemsHealth,
} from "@church/shared";
import { SettingsService } from "../../../settings/settings.service";
import { MonitorsService } from "../../../monitors/monitors.service";
import { InfraService } from "../../../infra/infra.service";
import { UnifiService } from "../../../unifi/unifi.service";
import { CiscoService } from "../../../cisco/cisco.service";
import { DnsService } from "../../../dns/dns.service";
import type { HomeContext, SectionBuilder } from "../home.types";
import { TtlCache, withDeadline } from "../cache";

type Area = SystemsHealth["areas"][number];
type Problem = SystemsHealth["problems"][number];

export const UNIFI_CACHE_MS = 15_000;
export const DNS_CACHE_MS = 60_000;
/** Each area gets less than the section's own 2.5 s, so one slow source leaves the others standing. */
export const AREA_DEADLINE_MS = 2_200;
/**
 * How long one computed "systems" answer is shared by everyone who may see it. The answer is the same for every
 * such person (only the UniFi permission changes which areas exist), and a monitoring event makes every open home
 * page ask at the same moment: this turns that burst into one computation. Maintenance mode and the write flag are
 * read live, so toggling it shows at once.
 */
export const SYSTEMS_SHARED_MS = 5_000;
/** An integration that failed or timed out is not asked again for this long (its areas show unavailable). */
export const INTEGRATION_FAIL_MS = 15_000;

const AREA_META: Record<AreaKey, { label: string; href: string }> = {
  servers: { label: "Servers", href: "/monitoring/infra" },
  internet: { label: "Internet", href: "/monitoring" },
  wifi: { label: "Wi-Fi", href: "/monitoring/network" },
  switches: { label: "Switches", href: "/monitoring/network-cisco" },
  dns: { label: "DNS", href: "/dns" },
};

interface AreaResult {
  area: Area;
  problems: Problem[];
}

interface UnifiDeviceRow {
  name?: string;
  model?: string;
  mac?: string;
  state?: number;
  acked?: boolean;
  last_seen?: number;
}

function blank(key: AreaKey, state: Area["state"], note: string | null): AreaResult {
  const meta = AREA_META[key];
  return { area: { key, ...meta, state, up: 0, down: 0, total: 0, note }, problems: [] };
}

function isoOrNull(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0) || 0;
}

/** Building the "is everything running" view: one area per source, each failing on its own. */
@Injectable()
export class HomeSystemsSection implements SectionBuilder<SystemsHealth> {
  private readonly cache = new TtlCache();

  constructor(
    private readonly settings: SettingsService,
    private readonly monitors: MonitorsService,
    private readonly infra: InfraService,
    private readonly unifi: UnifiService,
    private readonly cisco: CiscoService,
    private readonly dns: DnsService,
  ) {}

  async build(ctx: HomeContext): Promise<Section<SystemsHealth>> {
    const perms = ctx.user.permissions;
    if (!perms.includes(PERMISSIONS.MONITORS_READ_ANY)) return sectionOff("forbidden");
    const canUnifi = perms.includes(PERMISSIONS.UNIFI_READ_ANY);

    const [shared, maintenance] = await Promise.all([
      this.cache.get(`systems|${canUnifi}`, SYSTEMS_SHARED_MS, () => this.compute(canUnifi)),
      this.settings.get("monitoring.maintenance_mode").catch(() => false),
    ]);
    return sectionOk({
      ...shared,
      maintenanceMode: maintenance === true,
      canWrite: perms.includes(PERMISSIONS.MONITORS_WRITE_ANY),
    });
  }

  /** The part of the answer that is the same for everyone who may see the section. */
  private async compute(canUnifi: boolean): Promise<Pick<SystemsHealth, "areas" | "totals" | "problems">> {
    const guard = async (key: AreaKey, run: () => Promise<AreaResult>): Promise<AreaResult> => {
      try {
        return await withDeadline(run(), AREA_DEADLINE_MS, "timed out");
      } catch (err) {
        return blank(key, "unavailable", err instanceof Error && err.message === "timed out" ? "timed out" : "unavailable");
      }
    };

    const [servers, internet, wifi, switches, dns] = await Promise.all([
      guard("servers", () => this.servers()),
      guard("internet", () => this.internet()),
      canUnifi ? guard("wifi", () => this.wifi()) : Promise.resolve(blank("wifi", "forbidden", null)),
      guard("switches", () => this.switches()),
      guard("dns", () => this.dnsArea()),
    ]);

    const results = [servers, internet, wifi, switches, dns];
    const areas = results.map((r) => r.area);
    const totals = { up: 0, down: 0, total: 0 };
    for (const a of areas) {
      if (a.state !== "ok") continue;
      totals.up += a.up;
      totals.down += a.down;
      totals.total += a.total;
    }
    return { areas, totals, problems: results.flatMap((r) => r.problems) };
  }

  private async servers(): Promise<AreaResult> {
    const sum = await this.infra.summary();
    const t = sum.targets;
    const down = num(t.down) + num(t.degraded);
    const total = num(t.up) + down;
    if (total === 0) return blank("servers", "unconfigured", "none set up");
    const meta = AREA_META.servers;
    const area: Area = { key: "servers", ...meta, state: "ok", up: num(t.up), down, total, note: null };
    const problems: Problem[] = [];
    if (down > 0) {
      const [targets, incidents] = await Promise.all([this.infra.list(), this.infra.openIncidents()]);
      const since = new Map<string, Date>();
      for (const inc of incidents) {
        if (!inc.targetId) continue;
        const prev = since.get(inc.targetId);
        if (!prev || inc.startedAt < prev) since.set(inc.targetId, inc.startedAt);
      }
      for (const tg of targets) {
        if (!tg.enabled || (tg.status !== "down" && tg.status !== "degraded")) continue;
        problems.push({
          id: `servers:${tg.id}`,
          area: "servers",
          name: tg.name,
          detail: tg.lastError ?? (tg.status === "degraded" ? "degraded" : "not responding"),
          since: isoOrNull(since.get(tg.id)),
          href: `/monitoring/infra/${tg.id}`,
          ack: null,
        });
      }
    }
    return { area, problems };
  }

  private async internet(): Promise<AreaResult> {
    const sum = await this.monitors.summary();
    if (num(sum.total) === 0) return blank("internet", "unconfigured", "none set up");
    const area: Area = {
      key: "internet",
      ...AREA_META.internet,
      state: "ok",
      up: num(sum.up),
      down: num(sum.down),
      total: num(sum.total),
      note: null,
    };
    const problems: Problem[] = [];
    if (area.down > 0) {
      const [rows, incidents] = await Promise.all([this.monitors.list(), this.monitors.openIncidents()]);
      const incidentBy = new Map<string, { startedAt: Date; reason: string | null }>();
      for (const inc of incidents) {
        if (!inc.monitorId) continue;
        const prev = incidentBy.get(inc.monitorId);
        if (!prev || inc.startedAt < prev.startedAt) incidentBy.set(inc.monitorId, { startedAt: inc.startedAt, reason: inc.reason });
      }
      for (const m of rows) {
        if (!m.enabled || m.status !== "down") continue;
        const inc = incidentBy.get(m.id);
        problems.push({
          id: `internet:${m.id}`,
          area: "internet",
          name: m.name,
          detail: inc?.reason ?? m.target,
          since: isoOrNull(inc?.startedAt),
          href: `/monitoring/${m.id}`,
          ack: null,
        });
      }
    }
    return { area, problems };
  }

  private async wifi(): Promise<AreaResult> {
    const data = await this.cache.get(
      "unifi",
      UNIFI_CACHE_MS,
      async () => {
        const summary = await this.unifi.summary();
        const offline: UnifiDeviceRow[] =
          summary.configured && summary.reachable && summary.devices.offline > 0
            ? ((await this.unifi.devices()) as UnifiDeviceRow[]).filter((d) => d.state !== 1)
            : [];
        return { summary, offline };
      },
      { failTtlMs: INTEGRATION_FAIL_MS, deadlineMs: AREA_DEADLINE_MS },
    );
    const s = data.summary;
    if (!s.configured) return blank("wifi", "unconfigured", "not configured");
    if (!s.reachable) return blank("wifi", "unavailable", "controller unreachable");
    const area: Area = {
      key: "wifi",
      ...AREA_META.wifi,
      state: "ok",
      up: s.devices.online,
      down: s.devices.offline,
      total: s.devices.total,
      note: null,
    };
    const problems: Problem[] = data.offline.map((d, i) => {
      const mac = d.mac ? d.mac.trim().toLowerCase() : null;
      return {
        id: `wifi:${mac ?? i}`,
        area: "wifi" as const,
        name: d.name || d.model || mac || "UniFi device",
        detail: d.model && d.name ? d.model : null,
        since: typeof d.last_seen === "number" && d.last_seen > 0 ? new Date(d.last_seen * 1000).toISOString() : null,
        href: "/monitoring/network",
        ack: mac ? { kind: "unifi" as const, mac, acked: d.acked === true } : null,
      };
    });
    return { area, problems };
  }

  private async switches(): Promise<AreaResult> {
    const list = await this.cisco.list();
    if (list.length === 0) return blank("switches", "unconfigured", "none set up");
    const down = list.filter((s) => s.reachable === false);
    const area: Area = {
      key: "switches",
      ...AREA_META.switches,
      state: "ok",
      up: list.length - down.length,
      down: down.length,
      total: list.length,
      note: null,
    };
    const problems: Problem[] = down.map((s) => ({
      id: `switches:${s.id}`,
      area: "switches" as const,
      name: s.hostname,
      detail: s.lastError ?? "unreachable",
      since: null,
      href: `/monitoring/network-cisco`,
      ack: null,
    }));
    return { area, problems };
  }

  private async dnsArea(): Promise<AreaResult> {
    const s = await this.cache.get("dns", DNS_CACHE_MS, () => this.dns.summary(), {
      failTtlMs: INTEGRATION_FAIL_MS,
      deadlineMs: AREA_DEADLINE_MS,
    });
    if (!s.configured) return blank("dns", "unconfigured", "not configured");
    const meta = AREA_META.dns;
    if (!s.reachable) {
      return {
        area: { key: "dns", ...meta, state: "ok", up: 0, down: 1, total: 1, note: "primary unreachable" },
        problems: [
          {
            id: "dns:primary",
            area: "dns",
            name: "DNS primary",
            detail: s.error ?? "unreachable",
            since: null,
            href: meta.href,
            ack: null,
          },
        ],
      };
    }
    const total = s.nodes?.length || 1;
    const down = s.unreachableNodes;
    const problems: Problem[] = (s.nodes ?? [])
      .filter((n) => n.state !== "Self" && n.state !== "Connected")
      .map((n) => ({
        id: `dns:${n.name}`,
        area: "dns" as const,
        name: n.name || n.ipAddress || "DNS node",
        detail: n.state,
        since: isoOrNull(n.lastSeen),
        href: meta.href,
        ack: null,
      }));
    return { area: { key: "dns", ...meta, state: "ok", up: total - down, down, total, note: null }, problems };
  }
}
