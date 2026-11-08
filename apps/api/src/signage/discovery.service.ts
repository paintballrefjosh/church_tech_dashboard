import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  SIGNAGE_KEYS,
  SIGNAGE_LIMITS,
  evidenceRank,
  expandCidr,
  isPrivateUnicast,
  judgeEvidence,
  normaliseMac,
  type SignageDiscoverySubnet,
  type SignageDiscoverySubnetInput,
  type SignageEvidence,
  type SignageFoundPi,
} from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { ciscoArpCache, ipamHosts, signageDevices, signageDiscoverySubnets, signageFound } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { LeaseService } from "../cluster/lease.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { UnifiService } from "../unifi/unifi.service";
import { SignageService } from "./signage.service";
import { mapLimit } from "./devices.service";
import { PiSession, peekSsh } from "./pi-ssh";

type FoundRow = typeof signageFound.$inferSelect;
type SubnetRow = typeof signageDiscoverySubnets.$inferSelect;

const CONNECTS_AT_ONCE = 16;
const CONNECT_TIMEOUT_MS = 1_000;

interface Names {
  mac: Map<string, string>;
  name: Map<string, string>;
}

/**
 * Finding Pis (docs/signage.md section 2). Discovery NEVER logs in: it connects to port 22, reads the banner and the host
 * key, and ranks the address by what the dashboard already knows about it (a Raspberry Pi MAC from UniFi, the Cisco ARP
 * cache or IPAM; a name; the setup banner). Only "Set up" and "Show a code" use a password.
 */
@Injectable()
export class SignageDiscovery implements OnModuleInit {
  private readonly logger = new Logger(SignageDiscovery.name);
  private readonly scanning = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly leases: LeaseService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly unifi: UnifiService,
    private readonly content: SignageService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "signage-discover", everyMs: 60_000, initialDelayMs: 45_000, schedule: "fixed-delay", run: () => this.tick() });
  }

  // ------------------------------------------------------------ subnets

  private subnetDto(r: SubnetRow): SignageDiscoverySubnet {
    return { id: r.id, cidr: r.cidr, label: r.label, continuous: r.continuous, intervalMin: r.intervalMin, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastFound: r.lastFound, running: this.scanning.has(r.cidr) };
  }

  async subnets(): Promise<SignageDiscoverySubnet[]> {
    return (await this.db.select().from(signageDiscoverySubnets).orderBy(signageDiscoverySubnets.cidr)).map((r) => this.subnetDto(r));
  }

  private checkCidr(cidr: string): string[] {
    const e = expandCidr(cidr);
    if ("error" in e) throw new BadRequestException(e.error);
    if (e.ips.length > SIGNAGE_LIMITS.maxScanAddresses) throw new BadRequestException(`At most ${SIGNAGE_LIMITS.maxScanAddresses} addresses (a /22) at once`);
    if (!e.ips.every(isPrivateUnicast)) throw new BadRequestException("Only private addresses (10.x, 172.16-31.x, 192.168.x) can be scanned");
    return e.ips;
  }

  async addSubnet(input: SignageDiscoverySubnetInput): Promise<SignageDiscoverySubnet> {
    this.checkCidr(input.cidr);
    const [dupe] = await this.db.select({ id: signageDiscoverySubnets.id }).from(signageDiscoverySubnets).where(eq(signageDiscoverySubnets.cidr, input.cidr));
    if (dupe) throw new ConflictException("That subnet is already listed");
    const [r] = await this.db.insert(signageDiscoverySubnets).values(input).returning();
    return this.subnetDto(r!);
  }

  async updateSubnet(id: string, input: { continuous?: boolean; intervalMin?: number; label?: string }): Promise<SignageDiscoverySubnet> {
    const [r] = await this.db.update(signageDiscoverySubnets).set(input).where(eq(signageDiscoverySubnets.id, id)).returning();
    if (!r) throw new NotFoundException("No such subnet");
    return this.subnetDto(r);
  }

  async deleteSubnet(id: string): Promise<void> {
    await this.db.delete(signageDiscoverySubnets).where(eq(signageDiscoverySubnets.id, id));
  }

  /** Scan a listed subnet now (returns when done: a /24 takes about 20 s). */
  async scanSubnet(id: string): Promise<{ found: number; newFound: number }> {
    const [r] = await this.db.select().from(signageDiscoverySubnets).where(eq(signageDiscoverySubnets.id, id));
    if (!r) throw new NotFoundException("No such subnet");
    return this.scanCidr(r.cidr, r.continuous, r.id);
  }

  async scanCidr(cidr: string, continuous = false, subnetId?: string): Promise<{ found: number; newFound: number }> {
    const ips = this.checkCidr(cidr);
    const mutex = await this.leases.acquireMutex("signage-discover", 120);
    if (!mutex) throw new ConflictException("Another scan is running. Try again in a minute.");
    this.scanning.add(cidr);
    try {
      const res = await this.scan(ips, continuous);
      if (subnetId) await this.db.update(signageDiscoverySubnets).set({ lastRunAt: new Date(), lastFound: res.found }).where(eq(signageDiscoverySubnets.id, subnetId));
      return res;
    } finally {
      this.scanning.delete(cidr);
      await mutex.release();
    }
  }

  async addIps(ips: string[]): Promise<{ found: number; newFound: number; unreachable: string[] }> {
    const bad = ips.filter((ip) => !isPrivateUnicast(ip));
    if (bad.length) throw new BadRequestException(`Not private addresses: ${bad.join(", ")}`);
    const res = await this.scan([...new Set(ips)], false);
    const seen = new Set((await this.db.select({ ip: signageFound.ip }).from(signageFound).where(inArray(signageFound.ip, ips))).map((r) => r.ip));
    const devices = new Set((await this.db.select({ ip: signageDevices.ip }).from(signageDevices).where(inArray(signageDevices.ip, ips))).map((r) => r.ip));
    return { ...res, unreachable: ips.filter((ip) => !seen.has(ip) && !devices.has(ip)) };
  }

  // ------------------------------------------------------------ scanning

  private async names(): Promise<Names> {
    const mac = new Map<string, string>();
    const name = new Map<string, string>();
    const ipam = await this.db.select({ ip: ipamHosts.ipAddress, mac: ipamHosts.macAddress, host: ipamHosts.hostname, nb: ipamHosts.netbiosName, un: ipamHosts.unifiName }).from(ipamHosts);
    for (const h of ipam) {
      if (h.mac) mac.set(h.ip, h.mac);
      const n = h.un || h.nb || h.host;
      if (n) name.set(h.ip, n);
    }
    const arp = await this.db.select({ ip: ciscoArpCache.ipAddress, mac: ciscoArpCache.macAddress }).from(ciscoArpCache);
    for (const a of arp) if (a.mac && !mac.has(a.ip)) mac.set(a.ip, a.mac);
    try {
      for (const c of (await this.unifi.clients()) as Array<{ ip?: string; mac?: string; name?: string; hostname?: string }>) {
        if (!c.ip) continue;
        if (c.mac) mac.set(c.ip, c.mac);
        const n = c.name || c.hostname;
        if (n) name.set(c.ip, n);
      }
    } catch (err) {
      this.logger.debug(`signage discovery: UniFi clients not read: ${(err as Error).message}`);
    }
    return { mac, name };
  }

  /** Probe addresses and record the SSH hosts. A host key that belongs to a set-up device updates that device's address. */
  async scan(ips: string[], continuous: boolean): Promise<{ found: number; newFound: number }> {
    const [names, pattern, devices] = await Promise.all([
      this.names(),
      this.settings.get(SIGNAGE_KEYS.discoverNamePattern).then((v) => String(v ?? "") || "raspberrypi*"),
      this.db.select({ id: signageDevices.id, ip: signageDevices.ip, key: signageDevices.knownHostKey }).from(signageDevices),
    ]);
    const byKey = new Map(devices.filter((d) => d.key).map((d) => [d.key!, d]));
    const deviceIps = new Set(devices.map((d) => d.ip));
    let found = 0;
    let newFound = 0;
    await mapLimit(ips, CONNECTS_AT_ONCE, async (ip) => {
      const p = await peekSsh(ip, 22, CONNECT_TIMEOUT_MS);
      if (!p.open) return;
      const known = p.hostKey ? byKey.get(p.hostKey) : undefined;
      if (known) {
        if (known.ip !== ip) await this.db.update(signageDevices).set({ ip, updatedAt: new Date() }).where(eq(signageDevices.id, known.id));
        await this.db.delete(signageFound).where(eq(signageFound.ip, ip));
        return;
      }
      if (deviceIps.has(ip)) return;
      const mac = normaliseMac(names.mac.get(ip));
      const name = names.name.get(ip) ?? null;
      const e = judgeEvidence({ mac, name, banner: p.banner, namePattern: pattern });
      found++;
      const [existing] = await this.db.select().from(signageFound).where(eq(signageFound.ip, ip));
      if (!existing) {
        await this.db.insert(signageFound).values({ ip, hostKey: p.hostKey, banner: p.banner, evidence: e.evidence, evidenceText: e.text, mac, name, isNew: continuous && evidenceRank(e.evidence) <= evidenceRank("ssh_debian") }).onConflictDoNothing();
        if (continuous) newFound++;
      } else {
        const keyChanged = !!p.hostKey && existing.hostKey !== p.hostKey;
        await this.db
          .update(signageFound)
          .set({ hostKey: p.hostKey, banner: p.banner, evidence: e.evidence, evidenceText: e.text, mac: mac ?? existing.mac, name: name ?? existing.name, lastSeenAt: new Date(), ...(keyChanged ? { dismissedAt: null, isNew: continuous, notifiedAt: null } : {}) })
          .where(eq(signageFound.id, existing.id));
        if (keyChanged && continuous) newFound++;
      }
    });
    await this.notifyNew();
    return { found, newFound };
  }

  /** One notice per newly found Pi (if the setting is on), CLAIMED by `notified_at` so two nodes never both send it. */
  private async notifyNew(): Promise<void> {
    if ((await this.settings.get(SIGNAGE_KEYS.notifyNewPis)) !== true) return;
    const rows = await this.db.select().from(signageFound).where(and(eq(signageFound.isNew, true), isNull(signageFound.notifiedAt), isNull(signageFound.dismissedAt)));
    if (!rows.length) return;
    const recipients = await this.content.recipientIds(true);
    for (const f of rows) {
      const [claimed] = await this.db.update(signageFound).set({ notifiedAt: new Date() }).where(and(eq(signageFound.id, f.id), isNull(signageFound.notifiedAt))).returning();
      if (!claimed) continue;
      await this.notifications.createMany(
        recipients.map((id) => ({ recipientUserId: id, kind: "signage.pi_found", title: `New Pi found at ${f.ip}`, body: `${f.evidenceText}. Set it up or dismiss it on the Signage devices page.`, link: "/signage/devices?tab=found" })),
      );
    }
  }

  async tick(): Promise<void> {
    const rows = await this.db.select().from(signageDiscoverySubnets).where(eq(signageDiscoverySubnets.continuous, true));
    const now = Date.now();
    for (const r of rows) {
      if (r.lastRunAt && now - r.lastRunAt.getTime() < r.intervalMin * 60_000) continue;
      try {
        await this.scanCidr(r.cidr, true, r.id);
      } catch (err) {
        this.logger.debug(`signage discovery of ${r.cidr}: ${(err as Error).message}`);
      }
      return; // one subnet per tick
    }
  }

  // ------------------------------------------------------------ the found list

  async found(): Promise<SignageFoundPi[]> {
    const rows = await this.db.select().from(signageFound);
    const keys = rows.map((r) => r.hostKey).filter((k): k is string => !!k);
    const known = keys.length ? await this.db.select({ id: signageDevices.id, key: signageDevices.knownHostKey }).from(signageDevices).where(and(isNotNull(signageDevices.knownHostKey), inArray(signageDevices.knownHostKey, keys))) : [];
    const byKey = new Map(known.map((k) => [k.key!, k.id]));
    return rows
      .map((r) => ({
        id: r.id,
        ip: r.ip,
        hostKey: r.hostKey,
        banner: r.banner,
        evidence: r.evidence as SignageEvidence,
        evidenceText: r.evidenceText,
        mac: r.mac,
        name: r.name,
        firstSeenAt: r.firstSeenAt.toISOString(),
        lastSeenAt: r.lastSeenAt.toISOString(),
        isNew: r.isNew && !r.dismissedAt,
        dismissed: !!r.dismissedAt,
        knownDeviceId: r.hostKey ? (byKey.get(r.hostKey) ?? null) : null,
      }))
      .sort((a, b) => evidenceRank(a.evidence) - evidenceRank(b.evidence) || ipSort(a.ip, b.ip));
  }

  async dismiss(id: string, dismissed: boolean): Promise<void> {
    const [r] = await this.db.update(signageFound).set({ dismissedAt: dismissed ? new Date() : null, isNew: false }).where(eq(signageFound.id, id)).returning();
    if (!r) throw new NotFoundException("No such Pi");
  }

  async newCount(): Promise<number> {
    const [r] = await this.db.select({ n: sql<number>`count(*)` }).from(signageFound).where(and(eq(signageFound.isNew, true), isNull(signageFound.dismissedAt)));
    return Number(r?.n ?? 0);
  }

  /**
   * "Show a code" on a found Pi: log in with the setup login and print a large code on the TV's console (tty1), so a person
   * standing at the TV can say which address it is. Installs nothing; the host key seen must match the one discovery saw.
   */
  async showCode(id: string, login: { username?: string; password?: string }): Promise<{ code: string }> {
    const [f] = await this.db.select().from(signageFound).where(eq(signageFound.id, id));
    if (!f) throw new NotFoundException("No such Pi");
    const username = login.username || String((await this.settings.get(SIGNAGE_KEYS.setupUsername)) ?? "") || "pi";
    const password = login.password || String((await this.settings.get(SIGNAGE_KEYS.setupPassword)) ?? "");
    if (!password) throw new BadRequestException("No setup password: save one in Signage > Security settings, or type it.");
    const code = String(100 + Math.floor(Math.random() * 900));
    const s = await PiSession.open({ host: f.ip, port: 22, username, password, knownHostKey: f.hostKey, timeoutMs: 10_000 });
    try {
      const art = bigDigits(code);
      const script = `printf '\\033c\\033[?25l\\n\\n\\n' > /dev/tty1; printf '%s\\n' ${art.map((l) => `'          ${l}'`).join(" ")} > /dev/tty1; printf '\\n\\n          Lampstand: ${f.ip}\\n' > /dev/tty1`;
      let r = await s.exec(`sudo -n sh -c ${shellQuote(script)}`, { timeoutMs: 15_000 });
      if (r.code !== 0) r = await s.exec(`sudo -S -p '' sh -c ${shellQuote(script)}`, { stdin: `${password}\n`, timeoutMs: 15_000 });
      if (r.code !== 0) throw new ConflictException(`The code could not be shown: ${r.stderr.trim().slice(-200) || "sudo refused"}`);
    } finally {
      s.close();
    }
    return { code };
  }
}

function ipSort(a: string, b: string): number {
  const n = (ip: string) => ip.split(".").reduce((acc, p) => acc * 256 + Number(p), 0);
  return n(a) - n(b);
}

/** Single-quote for sh (the script is ours; this keeps it one word). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

const DIGITS: Record<string, string[]> = {
  "0": ["#####", "#   #", "#   #", "#   #", "#####"],
  "1": ["  #  ", " ##  ", "  #  ", "  #  ", "#####"],
  "2": ["#####", "    #", "#####", "#    ", "#####"],
  "3": ["#####", "    #", " ####", "    #", "#####"],
  "4": ["#   #", "#   #", "#####", "    #", "    #"],
  "5": ["#####", "#    ", "#####", "    #", "#####"],
  "6": ["#####", "#    ", "#####", "#   #", "#####"],
  "7": ["#####", "    #", "   # ", "  #  ", "  #  "],
  "8": ["#####", "#   #", "#####", "#   #", "#####"],
  "9": ["#####", "#   #", "#####", "    #", "#####"],
};

/** A three-digit code drawn in large block letters for the text console (each '#' doubled for width). */
export function bigDigits(code: string): string[] {
  const rows: string[] = [];
  for (let i = 0; i < 5; i++) {
    const line = [...code].map((c) => (DIGITS[c]?.[i] ?? "     ").replace(/#/g, "##").replace(/ /g, "  ")).join("    ");
    rows.push(line, line);
  }
  return rows;
}

export type { FoundRow };
