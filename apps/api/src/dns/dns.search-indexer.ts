import { createHash } from "node:crypto";
import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import type { DnsRecord } from "@church/shared";
import { SearchService, type SearchDoc } from "../search/search.service";
import { DnsService } from "./dns.service";

// Records live in Technitium, so nothing in this app sees edits made in its
// own UI; a periodic full read keeps search current. Writes made through the
// dashboard request a sync straight away (debounced).
const SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.DNS_SEARCH_SYNC_MS ?? "300000", 10) || 300_000,
);
const STARTUP_DELAY_MS = 30_000;
const WRITE_DEBOUNCE_MS = 2_000;
// Upper bound on indexed records, so a server hosting something huge (a
// blocklist-as-zone, a big public zone) can't flood the shared index.
const MAX_DOCS = 20_000;

/** `4.3.2.1.in-addr.arpa` → `1.2.3.4`; null for anything that isn't an IPv4 PTR name. */
export function ptrNameToIpv4(name: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa\.?$/i.exec(name);
  return m ? [m[4], m[3], m[2], m[1]].join(".") : null;
}

/**
 * Pushes every DNS record into the shared search index as `dns_record` docs
 * (gated on monitors:read:any at query time, like the other monitoring kinds).
 * The whole kind is replaced on each run. An unconfigured server clears it; an
 * unreachable one leaves the last good set in place.
 */
@Injectable()
export class DnsSearchIndexer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DnsSearchIndexer.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly dns: DnsService,
    private readonly search: SearchService,
  ) {}

  onModuleInit(): void {
    this.startup = setTimeout(() => void this.sync(), STARTUP_DELAY_MS);
    this.timer = setInterval(() => void this.sync(), SYNC_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startup) clearTimeout(this.startup);
    if (this.debounce) clearTimeout(this.debounce);
  }

  /** Called after a dashboard write; coalesces bursts into one sync. */
  requestSync(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.sync(), WRITE_DEBOUNCE_MS);
  }

  async sync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.dns.summary();
      if (!summary.configured) {
        await this.search.syncDns([]);
        return;
      }
      if (!summary.reachable) return;
      const docs: SearchDoc[] = [];
      const now = new Date().toISOString();
      for (const zone of await this.dns.zones()) {
        if (docs.length >= MAX_DOCS) break;
        let records: DnsRecord[];
        try {
          records = await this.dns.records(zone.name);
        } catch (err) {
          this.logger.debug(`dns index: zone ${zone.name} skipped: ${(err as Error).message}`);
          continue;
        }
        for (const r of records) {
          // The SOA/NS at the apex are bookkeeping, not something people search for.
          if (r.type === "SOA" || (r.type === "NS" && r.name === zone.name)) continue;
          docs.push(this.toDoc(zone.name, r, now));
          if (docs.length >= MAX_DOCS) break;
        }
      }
      if (docs.length >= MAX_DOCS) this.logger.warn(`dns index capped at ${MAX_DOCS} records`);
      await this.search.syncDns(docs);
    } catch (err) {
      this.logger.debug(`dns index sync failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Deep link into the Records view. The page's filter matches names and
   * values (not the derived IP), so a PTR hit filters on its target name; an
   * apex record ("@") has no useful filter and opens the zone unfiltered.
   */
  private recordUrl(zone: string, q: string): string {
    const base = `/monitoring/dns?zone=${encodeURIComponent(zone)}`;
    return q === "@" ? base : `${base}&q=${encodeURIComponent(q)}`;
  }

  private toDoc(zone: string, r: DnsRecord, now: string): SearchDoc {
    const ip = r.type === "PTR" ? ptrNameToIpv4(r.name) : null;
    const rel = r.name === zone ? "@" : r.name.endsWith(`.${zone}`) ? r.name.slice(0, -(zone.length + 1)) : r.name;
    // Doc ids must be [A-Za-z0-9_-]; record values (TXT especially) aren't, so hash.
    const hash = createHash("sha1").update(`${zone}|${r.name}|${r.type}|${r.value}`).digest("hex").slice(0, 24);
    return {
      id: `dns_record_${hash}`,
      kind: "dns_record",
      resourceId: `${zone}/${r.name}/${r.type}`,
      ownerUserId: null,
      title: ip ? `${ip} → ${r.value}` : r.name,
      body: [`${r.type} ${r.value}`, ip ? r.name : null, r.comments].filter(Boolean).join(" · "),
      extra: { zone, type: r.type },
      url: this.recordUrl(zone, ip ? r.value : rel),
      updatedAt: now,
    };
  }
}
