import { Injectable, Logger, Inject, type OnModuleInit } from "@nestjs/common";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { ipamSubnets, ipamHosts, ciscoArpCache } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { UnifiService } from "../unifi/unifi.service";
import { expandHosts, parseCidr } from "./cidr";
import { pingHost, tcpProbe, reverseDns, netbiosName } from "./probe";
import { IpamService } from "./ipam.service";
import { DnsSyncService } from "../dns/dns.sync";
import { ClusterJobs } from "../cluster/cluster-jobs.service";

/** Hard cap on hosts swept per subnet so a mistyped /16 can't melt the scanner. */
const MAX_HOSTS = 8192;
const DEFAULT_INTERVAL_MIN = 60;
const DEFAULT_CONCURRENCY = 32;
const DEFAULT_TIMEOUT_MS = 1000;
const DEFAULT_TCP_PORTS = "22,80,443,445,3389,139,7,9100,62078";

interface ScanConfig {
  concurrency: number;
  timeoutMs: number;
  dns: boolean;
  netbios: boolean;
  unifi: boolean;
  tcpPorts: number[];
}

interface HostResult {
  ip: string;
  up: boolean;
  respondedVia: string | null;
  openPorts: number[];
  hostname: string | null;
  netbiosName: string | null;
  unifiName: string | null;
  mac: string | null;
}

/** IP → MAC and IP → friendly name, both joined in from the Cisco ARP cache /
 * UniFi client list at scan time (see buildNetworkMaps). */
interface NetworkMaps {
  mac: Map<string, string>;
  unifiName: Map<string, string>;
}

type SubnetRow = typeof ipamSubnets.$inferSelect;

/**
 * Background IP sweep for the IPAM tab. Mirrors the CiscoPoller shape: a
 * fixed-delay cluster job (see ClusterJobs; no @nestjs/schedule) re-reading its
 * cadence from settings each tick so an operator can retune without a restart.
 *
 * Each enabled subnet is expanded to host addresses and probed ICMP-first with
 * a TCP-connect fallback (see probe.ts). Live hosts are upserted into
 * `ipam_hosts` with names (reverse DNS + NetBIOS as enabled, plus the UniFi
 * client alias/DHCP hostname) and a MAC, both joined in from the Cisco ARP
 * cache / UniFi client list; hosts that stop answering are flipped to
 * `is_up=false` but kept for history.
 *
 * Every tick also calls `IpamService.syncLabels()` to refresh subnet labels
 * still on auto from their source system's current name (UniFi network name /
 * Cisco VLAN name) — this runs unconditionally, since it's a cheap metadata
 * read, unlike the host sweep which respects `monitoring.ipam_scan_enabled`.
 */
@Injectable()
export class IpamScanner implements OnModuleInit {
  private readonly logger = new Logger(IpamScanner.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly unifi: UnifiService,
    private readonly ipam: IpamService,
    private readonly dnsSync: DnsSyncService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    // A cluster job: one node sweeps at a time. The cadence is re-read from
    // settings before each wait, so a change applies without a restart.
    this.jobs.register({
      name: "ipam-scan",
      everyMs: () => this.intervalMs().catch(() => DEFAULT_INTERVAL_MIN * 60_000),
      initialDelayMs: 20_000,
      schedule: "fixed-delay",
      run: () => this.tick(),
    });
    this.logger.log("IPAM scanner scheduled");
  }

  private async intervalMs(): Promise<number> {
    const min = await this.getNumber("monitoring.ipam_scan_interval_min", DEFAULT_INTERVAL_MIN);
    return Math.max(1, min) * 60_000;
  }

  private async tick(): Promise<void> {
    try {
      // Label sync is a cheap metadata refresh (no ICMP/TCP sweep), so it
      // runs every tick regardless of the host-scan enable toggle.
      await this.ipam.syncLabels();
    } catch (err) {
      this.logger.warn(`ipam label sync failed: ${(err as Error).message}`);
    }
    try {
      const enabled = ((await this.settings.get("monitoring.ipam_scan_enabled")) as boolean | undefined) ?? false;
      if (enabled) await this.scanAllDue();
    } catch (err) {
      this.logger.warn(`ipam tick failed: ${(err as Error).message}`);
    }
  }

  /** Sweep every scan-enabled subnet once, sharing one MAC map across them. */
  async scanAllDue(): Promise<void> {
    const rows = await this.db.select().from(ipamSubnets).where(eq(ipamSubnets.scanEnabled, true));
    if (!rows.length) return;
    const cfg = await this.loadConfig();
    const maps = await this.buildNetworkMaps();
    for (const row of rows) {
      if (this.inFlight.has(row.id)) continue;
      this.inFlight.add(row.id);
      try {
        await this.scanSubnet(row, cfg, maps);
      } catch (err) {
        this.logger.warn(`ipam scan ${row.cidr}: ${(err as Error).message}`);
      } finally {
        this.inFlight.delete(row.id);
      }
    }
    // Fresh names/addresses: publish them (debounced; no-op while sync is off).
    this.dnsSync.requestRun("ipam-scan");
  }

  /** On-demand scan of a single subnet (ignores the master switch). */
  async scanSubnetById(id: string): Promise<void> {
    const [row] = await this.db.select().from(ipamSubnets).where(eq(ipamSubnets.id, id)).limit(1);
    if (!row || this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      const cfg = await this.loadConfig();
      const maps = await this.buildNetworkMaps();
      await this.scanSubnet(row, cfg, maps);
      if (row.dnsSync) this.dnsSync.requestRun("ipam-scan");
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async scanSubnet(row: SubnetRow, cfg: ScanConfig, maps: NetworkMaps): Promise<void> {
    const started = new Date();
    await this.db
      .update(ipamSubnets)
      .set({ lastScanStartedAt: started, updatedAt: started })
      .where(eq(ipamSubnets.id, row.id));

    const parsed = parseCidr(row.cidr);
    const ips = expandHosts(row.cidr, MAX_HOSTS);
    const truncated = parsed ? parsed.hostCount > ips.length : false;

    // Bounded worker pool over the host list (mirrors CiscoPoller.pollAll).
    const results: HostResult[] = [];
    let idx = 0;
    const workers = Array.from({ length: Math.min(cfg.concurrency, ips.length) }, async () => {
      while (idx < ips.length) {
        const ip = ips[idx++]!;
        results.push(await this.probeHost(ip, cfg, maps));
      }
    });
    await Promise.all(workers);

    const upResults = results.filter((r) => r.up);
    const upIps = upResults.map((r) => r.ip);
    const now = new Date();

    // Upsert live hosts in one statement; COALESCE keeps a previously-resolved
    // name/MAC when this pass didn't resolve one (e.g. DNS toggled off).
    if (upResults.length) {
      await this.db
        .insert(ipamHosts)
        .values(
          upResults.map((r) => ({
            subnetId: row.id,
            ipAddress: r.ip,
            macAddress: r.mac,
            hostname: r.hostname,
            netbiosName: r.netbiosName,
            unifiName: r.unifiName,
            isUp: true,
            respondedVia: r.respondedVia,
            openPorts: r.openPorts,
            firstSeenAt: now,
            lastSeenAt: now,
            lastScanAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [ipamHosts.subnetId, ipamHosts.ipAddress],
          set: {
            macAddress: sql`coalesce(excluded.mac_address, ${ipamHosts.macAddress})`,
            hostname: sql`coalesce(excluded.hostname, ${ipamHosts.hostname})`,
            netbiosName: sql`coalesce(excluded.netbios_name, ${ipamHosts.netbiosName})`,
            unifiName: sql`coalesce(excluded.unifi_name, ${ipamHosts.unifiName})`,
            isUp: true,
            respondedVia: sql`excluded.responded_via`,
            openPorts: sql`excluded.open_ports`,
            lastSeenAt: now,
            lastScanAt: now,
            updatedAt: now,
          },
        });
    }

    // Flip previously-seen hosts that no longer answer to down (kept for history).
    await this.db
      .update(ipamHosts)
      .set({ isUp: false, respondedVia: null, lastScanAt: now, updatedAt: now })
      .where(and(eq(ipamHosts.subnetId, row.id), notInArray(ipamHosts.ipAddress, upIps.length ? upIps : [" "])));

    const [{ total } = { total: 0 }] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(ipamHosts)
      .where(eq(ipamHosts.subnetId, row.id));

    await this.db
      .update(ipamSubnets)
      .set({
        lastScanFinishedAt: new Date(),
        hostCount: Number(total),
        aliveCount: upIps.length,
        lastError: truncated ? `Truncated: only the first ${MAX_HOSTS} of ${parsed?.hostCount} hosts were scanned` : null,
        updatedAt: new Date(),
      })
      .where(eq(ipamSubnets.id, row.id));
  }

  private async probeHost(ip: string, cfg: ScanConfig, maps: NetworkMaps): Promise<HostResult> {
    let respondedVia: string | null = null;
    let openPorts: number[] = [];

    if (await pingHost(ip, cfg.timeoutMs)) {
      respondedVia = "icmp";
    } else if (cfg.tcpPorts.length) {
      const t = await tcpProbe(ip, cfg.tcpPorts, cfg.timeoutMs);
      if (t.up) {
        respondedVia = "tcp";
        openPorts = t.openPorts;
      }
    }

    if (respondedVia === null) {
      return { ip, up: false, respondedVia: null, openPorts: [], hostname: null, netbiosName: null, unifiName: null, mac: null };
    }

    const nameTimeout = Math.max(500, cfg.timeoutMs);
    const [hostname, nb] = await Promise.all([
      cfg.dns ? reverseDns(ip) : Promise.resolve(null),
      cfg.netbios ? netbiosName(ip, nameTimeout) : Promise.resolve(null),
    ]);

    return {
      ip,
      up: true,
      respondedVia,
      openPorts,
      hostname,
      netbiosName: nb,
      // UniFi name needs no per-host probe — it comes from the controller's
      // client list, looked up in the pre-built map.
      unifiName: cfg.unifi ? (maps.unifiName.get(ip) ?? null) : null,
      mac: maps.mac.get(ip) ?? null,
    };
  }

  /**
   * Build IP → MAC and IP → friendly-name maps from the Cisco ARP cache and the
   * live UniFi client/device lists. The UniFi name prefers the operator alias
   * (`name`) and falls back to the DHCP `hostname` — this is where phone / IoT
   * names come from, since those devices only announce over link-local mDNS
   * that never reaches this off-subnet scanner.
   */
  private async buildNetworkMaps(): Promise<NetworkMaps> {
    const mac = new Map<string, string>();
    const unifiName = new Map<string, string>();
    try {
      const arps = await this.db
        .select({ ip: ciscoArpCache.ipAddress, mac: ciscoArpCache.macAddress })
        .from(ciscoArpCache);
      for (const a of arps) if (a.mac) mac.set(a.ip, a.mac.toLowerCase());
    } catch {
      /* cisco not populated — fine */
    }
    try {
      const [clients, devices] = await Promise.all([this.unifi.clients(), this.unifi.devices()]);
      for (const c of [...clients, ...devices] as Array<{ ip?: string; mac?: string; name?: string; hostname?: string }>) {
        if (!c.ip) continue;
        if (c.mac && !mac.has(c.ip)) mac.set(c.ip, c.mac.toLowerCase());
        const name = c.name?.trim() || c.hostname?.trim();
        if (name && !unifiName.has(c.ip)) unifiName.set(c.ip, name);
      }
    } catch {
      /* unifi unconfigured/unreachable — fine */
    }
    return { mac, unifiName };
  }

  private async loadConfig(): Promise<ScanConfig> {
    const [concurrency, timeoutMs] = await Promise.all([
      this.getNumber("monitoring.ipam_concurrency", DEFAULT_CONCURRENCY),
      this.getNumber("monitoring.ipam_host_timeout_ms", DEFAULT_TIMEOUT_MS),
    ]);
    const dns = ((await this.settings.get("monitoring.ipam_dns_lookup")) as boolean | undefined) ?? true;
    const netbios = ((await this.settings.get("monitoring.ipam_netbios")) as boolean | undefined) ?? false;
    const unifi = ((await this.settings.get("monitoring.ipam_unifi_names")) as boolean | undefined) ?? true;
    const portsRaw = ((await this.settings.get("monitoring.ipam_tcp_ports")) as string | undefined) ?? DEFAULT_TCP_PORTS;
    const tcpPorts = portsRaw
      .split(",")
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
    return {
      concurrency: Math.max(1, Math.min(256, concurrency)),
      timeoutMs: Math.max(100, timeoutMs),
      dns,
      netbios,
      unifi,
      tcpPorts,
    };
  }

  private async getNumber(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  }
}
