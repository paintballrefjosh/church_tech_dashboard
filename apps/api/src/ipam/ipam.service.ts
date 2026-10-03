import { Injectable, Inject, NotFoundException, ConflictException, BadRequestException } from "@nestjs/common";
import { asc, desc, eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { ipamSubnets, ipamHosts, ciscoSwitches, ciscoConfigBackups, ciscoArpCache, ciscoVlanDb } from "../db/schema";
import { UnifiService } from "../unifi/unifi.service";
import { SettingsService } from "../settings/settings.service";
import type {
  IpamSubnet,
  IpamHost,
  IpamDiscoveredSubnet,
  IpamSummary,
  IpamSubnetSource,
  CreateIpamSubnetInput,
  UpdateIpamSubnetInput,
} from "@church/shared";
import { parseCidr, normalizeCidr, ipToInt, ipToSlash24 } from "./cidr";

type SubnetRow = typeof ipamSubnets.$inferSelect;
type HostRow = typeof ipamHosts.$inferSelect;

/** Convert a dotted subnet mask (255.255.255.0) to a prefix length, or null if
 * it isn't a contiguous mask. */
function maskToPrefix(mask: string): number | null {
  const n = ipToInt(mask);
  if (n === null) return null;
  let prefix = 0;
  let seenZero = false;
  for (let i = 31; i >= 0; i--) {
    if ((n >>> i) & 1) {
      if (seenZero) return null; // non-contiguous
      prefix++;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

interface DerivedSubnet {
  cidr: string;
  gateway: string | null;
  vlanId: number | null;
  source: IpamSubnetSource;
  sourceDetail: string | null;
  /** Interface name from the source system (UniFi network name / Cisco VLAN name). */
  label: string | null;
}

/**
 * Parse SVI / routed-interface `ip address` lines out of a stored running-config
 * blob. Handles IOS ("ip address <ip> <mask>") and NX-OS ("ip address <ip>/<n>")
 * and tags each with the VLAN id when it appears inside an `interface VlanN`.
 */
function parseCiscoConfigSubnets(text: string, hostname: string): DerivedSubnet[] {
  const out: DerivedSubnet[] = [];
  let curVlan: number | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const ifm = /^interface\s+(\S+)/i.exec(line);
    if (ifm) {
      const vm = /^vlan(\d+)$/i.exec(ifm[1] ?? "");
      curVlan = vm ? Number(vm[1]) : null;
      continue;
    }
    if (/^no ip address/i.test(line)) continue;
    let ip: string | null = null;
    let prefix: number | null = null;
    let m = /^ip address (\d+\.\d+\.\d+\.\d+) (\d+\.\d+\.\d+\.\d+)/i.exec(line);
    if (m) {
      ip = m[1] ?? null;
      prefix = m[2] ? maskToPrefix(m[2]) : null;
    } else {
      m = /^ip address (\d+\.\d+\.\d+\.\d+)\/(\d+)/i.exec(line);
      if (m) {
        ip = m[1] ?? null;
        prefix = m[2] ? Number(m[2]) : null;
      }
    }
    if (!ip || prefix === null || prefix < 8 || prefix > 32 || ip === "0.0.0.0") continue;
    const norm = normalizeCidr(`${ip}/${prefix}`);
    if (!norm) continue;
    out.push({ cidr: norm.cidr, gateway: norm.gateway, vlanId: curVlan, source: "cisco", sourceDetail: hostname, label: null });
  }
  return out;
}

@Injectable()
export class IpamService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly unifi: UnifiService,
    private readonly settings: SettingsService,
  ) {}

  // ---- subnet CRUD ----

  async list(): Promise<IpamSubnet[]> {
    const rows = await this.db.select().from(ipamSubnets).orderBy(asc(ipamSubnets.cidr));
    return rows.map(toSubnet);
  }

  private async rowById(id: string): Promise<SubnetRow> {
    const [row] = await this.db.select().from(ipamSubnets).where(eq(ipamSubnets.id, id)).limit(1);
    if (!row) throw new NotFoundException("Subnet not found");
    return row;
  }

  async getById(id: string): Promise<IpamSubnet> {
    return toSubnet(await this.rowById(id));
  }

  async create(input: CreateIpamSubnetInput): Promise<IpamSubnet> {
    const parsed = parseCidr(input.cidr);
    if (!parsed) throw new BadRequestException("Invalid CIDR");
    const cidr = parsed.cidr; // normalise to the network address
    const [dup] = await this.db
      .select({ id: ipamSubnets.id })
      .from(ipamSubnets)
      .where(eq(ipamSubnets.cidr, cidr))
      .limit(1);
    if (dup) throw new ConflictException("That subnet is already managed");
    const [row] = await this.db
      .insert(ipamSubnets)
      .values({
        cidr,
        label: input.label?.trim() ?? "",
        // A label typed on manual add is a deliberate choice — don't let a
        // later label sync (e.g. once this CIDR matches a discovered VLAN)
        // overwrite it. Left blank, it's still fair game for auto-fill.
        labelAuto: !input.label?.trim(),
        vlanId: input.vlanId ?? null,
        gateway: input.gateway?.trim() || null,
        source: "manual",
        scanEnabled: input.scanEnabled ?? true,
      })
      .returning();
    return toSubnet(row!);
  }

  async update(id: string, input: UpdateIpamSubnetInput): Promise<IpamSubnet> {
    await this.rowById(id);
    const patch: Partial<typeof ipamSubnets.$inferInsert> = { updatedAt: new Date() };
    // An explicit label edit is the operator overriding whatever the source
    // system called it — stop the periodic sync from touching it again.
    if (input.label !== undefined) {
      patch.label = input.label.trim();
      patch.labelAuto = false;
    }
    if (input.vlanId !== undefined) patch.vlanId = input.vlanId;
    if (input.gateway !== undefined) patch.gateway = input.gateway?.trim() || null;
    if (input.scanEnabled !== undefined) patch.scanEnabled = input.scanEnabled;
    const [row] = await this.db.update(ipamSubnets).set(patch).where(eq(ipamSubnets.id, id)).returning();
    return toSubnet(row!);
  }

  async remove(id: string): Promise<{ ok: true }> {
    await this.rowById(id);
    await this.db.delete(ipamSubnets).where(eq(ipamSubnets.id, id));
    return { ok: true };
  }

  // ---- hosts ----

  async hosts(subnetId: string): Promise<IpamHost[]> {
    await this.rowById(subnetId);
    const rows = await this.db
      .select()
      .from(ipamHosts)
      .where(eq(ipamHosts.subnetId, subnetId))
      .orderBy(desc(ipamHosts.isUp), asc(sql`${ipamHosts.ipAddress}::inet`));
    return rows.map(toHost);
  }

  // ---- summary (tab badge) ----

  async summary(): Promise<IpamSummary> {
    const [subnetAgg] = await this.db
      .select({
        subnets: sql<number>`count(*)::int`,
        scanning: sql<number>`count(*) filter (where ${ipamSubnets.scanEnabled})::int`,
        errored: sql<number>`count(*) filter (where ${ipamSubnets.lastError} is not null)::int`,
      })
      .from(ipamSubnets);
    const [hostAgg] = await this.db
      .select({
        hosts: sql<number>`count(*)::int`,
        up: sql<number>`count(*) filter (where ${ipamHosts.isUp})::int`,
      })
      .from(ipamHosts);
    const enabled = ((await this.settings.get("monitoring.ipam_scan_enabled")) as boolean | undefined) ?? false;
    return {
      enabled,
      subnets: Number(subnetAgg?.subnets ?? 0),
      scanning: Number(subnetAgg?.scanning ?? 0),
      errored: Number(subnetAgg?.errored ?? 0),
      hosts: Number(hostAgg?.hosts ?? 0),
      up: Number(hostAgg?.up ?? 0),
    };
  }

  // ---- discovery (Cisco config/ARP + UniFi networkconf) ----

  /**
   * Derive candidate scan ranges from the network sources already in the DB /
   * reachable controllers. Sources, richest first: UniFi `rest/networkconf`
   * (authoritative CIDR + gateway + VLAN), Cisco SVI `ip address` lines from
   * the latest config backup, and — as a last resort — /24s inferred from
   * Cisco ARP host IPs. Shared by `discover()` (candidates not yet managed)
   * and `syncLabels()` (refreshing the label of subnets already managed).
   */
  private async deriveSubnets(): Promise<Map<string, DerivedSubnet>> {
    const derived: DerivedSubnet[] = [];

    // UniFi networks (authoritative).
    try {
      const nets = await this.unifi.networks();
      for (const n of nets) {
        if (!n.enabled || n.purpose === "wan" || !n.ipSubnet) continue;
        const norm = normalizeCidr(n.ipSubnet);
        if (!norm) continue;
        derived.push({
          cidr: norm.cidr,
          gateway: norm.gateway,
          vlanId: n.vlanId,
          source: "unifi",
          sourceDetail: n.name,
          label: n.name || null,
        });
      }
    } catch {
      /* UniFi unconfigured/unreachable — non-fatal */
    }

    // Cisco SVI subnets from the latest config backup per switch, labelled with
    // the matching VLAN's name from `show vlan brief` (cisco_vlan_db) when known.
    const switches = await this.db.select().from(ciscoSwitches);
    for (const sw of switches) {
      const [latest] = await this.db
        .select({ configText: ciscoConfigBackups.configText })
        .from(ciscoConfigBackups)
        .where(eq(ciscoConfigBackups.switchId, sw.id))
        .orderBy(desc(ciscoConfigBackups.backedUpAt))
        .limit(1);
      if (!latest?.configText) continue;
      const svis = parseCiscoConfigSubnets(latest.configText, sw.hostname);
      if (svis.some((s) => s.vlanId !== null)) {
        const vlanRows = await this.db
          .select({ vlanId: ciscoVlanDb.vlanId, vlanName: ciscoVlanDb.vlanName })
          .from(ciscoVlanDb)
          .where(eq(ciscoVlanDb.switchId, sw.id));
        const nameByVlan = new Map(vlanRows.map((v) => [v.vlanId, v.vlanName]));
        for (const s of svis) {
          if (s.vlanId !== null) s.label = nameByVlan.get(s.vlanId) || null;
        }
      }
      derived.push(...svis);
    }

    // Authoritative networks (uni/cisco config) collected so far — used to
    // suppress redundant /24s inferred from ARP that already sit inside one.
    const authoritative = derived
      .map((d) => parseCidr(d.cidr))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const containedByAuthoritative = (cidr: string): boolean => {
      const p = parseCidr(cidr);
      if (!p) return false;
      return authoritative.some((a) => p.network >= a.network && p.broadcast <= a.broadcast);
    };

    // Cisco ARP host IPs → inferred /24s (last resort, no mask/gateway).
    const arps = await this.db.select({ ip: ciscoArpCache.ipAddress }).from(ciscoArpCache);
    const inferred = new Set<string>();
    for (const a of arps) {
      const slash24 = ipToSlash24(a.ip);
      if (slash24) inferred.add(slash24);
    }
    for (const cidr of inferred) {
      if (!containedByAuthoritative(cidr)) {
        derived.push({ cidr, gateway: null, vlanId: null, source: "cisco", sourceDetail: "ARP", label: null });
      }
    }

    // Dedupe by CIDR, keeping the richest entry (a gateway/VLAN wins over none).
    const byCidr = new Map<string, DerivedSubnet>();
    for (const d of derived) {
      const prev = byCidr.get(d.cidr);
      if (!prev || (!prev.gateway && d.gateway) || (prev.vlanId === null && d.vlanId !== null)) {
        byCidr.set(
          d.cidr,
          prev
            ? { ...prev, ...d, gateway: d.gateway ?? prev.gateway, vlanId: d.vlanId ?? prev.vlanId, label: d.label ?? prev.label }
            : d,
        );
      }
    }

    return byCidr;
  }

  /**
   * Derive candidate scan ranges from the network sources already in the DB /
   * reachable controllers, minus the ones already managed.
   */
  async discover(): Promise<IpamDiscoveredSubnet[]> {
    const existing = await this.db.select({ cidr: ipamSubnets.cidr }).from(ipamSubnets);
    const existingSet = new Set(existing.map((e) => e.cidr));
    const byCidr = await this.deriveSubnets();

    return [...byCidr.values()]
      .map((d) => ({
        cidr: d.cidr,
        source: d.source,
        sourceDetail: d.sourceDetail,
        vlanId: d.vlanId,
        gateway: d.gateway,
        label: d.label,
        existing: existingSet.has(d.cidr),
      }))
      .sort((a, b) => cidrSortKey(a.cidr) - cidrSortKey(b.cidr));
  }

  /**
   * Refresh the label of every managed subnet whose label is still
   * auto-managed (`labelAuto`) from its current source name — the UniFi
   * network name or the matching Cisco VLAN name. A subnet's label stops
   * being touched here the moment an operator edits it by hand (`update()`
   * clears `labelAuto`), so a manual rename always sticks. Called on the
   * IPAM scanner's tick, independent of the host-sweep enable toggle since
   * this is a cheap metadata refresh, not a network sweep.
   */
  async syncLabels(): Promise<number> {
    const byCidr = await this.deriveSubnets();
    if (!byCidr.size) return 0;
    const rows = await this.db.select().from(ipamSubnets).where(eq(ipamSubnets.labelAuto, true));
    let updated = 0;
    for (const row of rows) {
      const d = byCidr.get(row.cidr);
      if (!d?.label || d.label === row.label) continue;
      await this.db.update(ipamSubnets).set({ label: d.label, updatedAt: new Date() }).where(eq(ipamSubnets.id, row.id));
      updated++;
    }
    return updated;
  }

  /** Add a discovered range as a managed subnet (idempotent — returns the
   * existing row if already managed). Records the discovery source. */
  async adopt(input: {
    cidr: string;
    source?: IpamSubnetSource;
    sourceDetail?: string | null;
    vlanId?: number | null;
    gateway?: string | null;
    label?: string | null;
  }): Promise<IpamSubnet> {
    const parsed = parseCidr(input.cidr);
    if (!parsed) throw new BadRequestException("Invalid CIDR");
    const cidr = parsed.cidr;
    const [dup] = await this.db.select().from(ipamSubnets).where(eq(ipamSubnets.cidr, cidr)).limit(1);
    if (dup) return toSubnet(dup);
    const [row] = await this.db
      .insert(ipamSubnets)
      .values({
        cidr,
        label: input.label?.trim() || "",
        vlanId: input.vlanId ?? null,
        gateway: input.gateway?.trim() || null,
        source: input.source ?? "manual",
        sourceDetail: input.sourceDetail ?? null,
        scanEnabled: true,
      })
      .returning();
    return toSubnet(row!);
  }
}

function cidrSortKey(cidr: string): number {
  const p = parseCidr(cidr);
  return p ? p.network : 0;
}

function toSubnet(r: SubnetRow): IpamSubnet {
  return {
    id: r.id,
    cidr: r.cidr,
    label: r.label,
    labelAuto: r.labelAuto,
    vlanId: r.vlanId,
    gateway: r.gateway,
    source: r.source as IpamSubnetSource,
    sourceDetail: r.sourceDetail,
    scanEnabled: r.scanEnabled,
    lastScanStartedAt: r.lastScanStartedAt?.toISOString() ?? null,
    lastScanFinishedAt: r.lastScanFinishedAt?.toISOString() ?? null,
    lastError: r.lastError,
    hostCount: r.hostCount,
    aliveCount: r.aliveCount,
    usableHosts: parseCidr(r.cidr)?.hostCount ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toHost(r: HostRow): IpamHost {
  return {
    id: r.id,
    ipAddress: r.ipAddress,
    macAddress: r.macAddress,
    hostname: r.hostname,
    netbiosName: r.netbiosName,
    unifiName: r.unifiName,
    isUp: r.isUp,
    respondedVia: r.respondedVia,
    openPorts: Array.isArray(r.openPorts) ? (r.openPorts as number[]) : [],
    firstSeenAt: r.firstSeenAt.toISOString(),
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    lastScanAt: r.lastScanAt?.toISOString() ?? null,
  };
}
