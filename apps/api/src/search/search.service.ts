import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { asc, eq } from "drizzle-orm";
import { MeiliSearch, type Index } from "meilisearch";
import { DB, type Db } from "../db/db.module";
import {
  tickets,
  notes,
  wikiPages,
  wikiPageAcl,
  monitors,
  infraTargets,
  infraEntities,
  ciscoSwitches,
  ciscoPorts,
  ciscoMacTable,
  ciscoArpCache,
  ciscoVlanDb,
  ipamSubnets,
  ipamHosts,
} from "../db/schema";

/**
 * Type discriminator stamped on every indexed document. Drives the result
 * label/colour on the frontend.
 */
export type SearchKind =
  | "ticket"
  | "note"
  | "wiki"
  | "monitor"
  | "infra_target"
  | "infra_entity"
  | "unifi_device"
  | "unifi_client"
  | "cisco_switch"
  | "cisco_port"
  | "cisco_mac"
  | "cisco_arp"
  | "cisco_vlan"
  | "ipam_subnet"
  | "ipam_host";

/**
 * Monitoring kinds visible to anyone with `monitors:read:any` (the `monitoring`
 * module read tier). UniFi kinds ride `unifi:read:any` separately — see
 * UNIFI_KINDS. Cisco reads also gate on `monitors:read:any` per the module doc.
 */
export const MONITORING_KINDS: SearchKind[] = [
  "monitor",
  "infra_target",
  "infra_entity",
  "cisco_switch",
  "cisco_port",
  "cisco_mac",
  "cisco_arp",
  "cisco_vlan",
  "ipam_subnet",
  "ipam_host",
];
export const UNIFI_KINDS: SearchKind[] = ["unifi_device", "unifi_client"];

/**
 * Build a Meilisearch document id from a kind + resource id.
 *
 * Meilisearch primary keys are restricted to alphanumerics, hyphens, and
 * underscores — a colon is rejected and the whole document-addition task fails
 * asynchronously (never surfaced to the enqueuing call). Join with `_` so the
 * id stays valid; resource UUIDs already contain hyphens, which are allowed.
 * The raw resource id is stored separately in `resourceId` for deep links.
 */
export function searchDocId(kind: SearchKind, resourceId: string): string {
  // Meilisearch primary keys allow only [A-Za-z0-9_-]; UUIDs already qualify,
  // but MAC-address-keyed docs (UniFi devices/clients) contain colons, so
  // sanitise. The raw value is preserved separately in `resourceId`.
  const safe = resourceId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${kind}_${safe}`;
}

export interface SearchDoc {
  /** "<kind>:<resourceId>" — stable across edits so an update overwrites in place. */
  id: string;
  kind: SearchKind;
  /** Resource UUID/key — what the UI uses to build a deep link. */
  resourceId: string;
  ownerUserId?: string | null;
  visibility?: "public" | "group" | "private" | null;
  /** Permission-bearing ACL — wiki pages store group ids here. Empty for everyone-readable. */
  aclGroupIds?: string[];
  title: string;
  body: string;
  tagIds?: string[];
  /** Free-form extra fields the frontend can render (e.g. ticket number, note color). */
  extra?: Record<string, unknown>;
  /**
   * Deep link for this result. Set at index time so kinds whose link target
   * differs from `resourceId` (e.g. an infra entity links to its parent target,
   * a Cisco MAC links to the lookup page) route correctly without the frontend
   * hard-coding every case.
   */
  url?: string;
  /** Document timestamp; we sort by recency as a secondary signal. */
  updatedAt: string;
}

export interface SearchResult extends SearchDoc {
  _formatted?: Partial<SearchDoc>;
}

const INDEX_NAME = "content";

/**
 * Wraps the Meilisearch client. A single index (`content`) holds all kinds;
 * filterable attributes let us scope queries per request (per kind, owner,
 * ACL) without fanning out across indexes.
 *
 * Indexing is best-effort and never blocks the caller — failures are logged
 * but the underlying mutation still succeeds. The data-of-record is the DB;
 * Meilisearch can be wiped and re-built any time.
 */
// Periodic refresh of the DB-backed monitoring kinds (infra + cisco caches are
// written by their pollers; this picks up their churn without a manual reindex).
// UniFi kinds are pushed live by the UnifiPoller instead (they aren't in the DB).
const MONITORING_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.SEARCH_MONITORING_SYNC_MS ?? "120000", 10) || 120_000,
);

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private client: MeiliSearch | null = null;
  private indexPromise: Promise<Index> | null = null;
  private monitoringTimer: ReturnType<typeof setInterval> | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async onModuleInit(): Promise<void> {
    const host = process.env.MEILI_URL;
    if (!host) {
      this.logger.warn("MEILI_URL not set — search disabled");
      return;
    }
    this.client = new MeiliSearch({ host, apiKey: process.env.MEILI_MASTER_KEY });
    // Bootstrap the index + settings on startup. Idempotent — Meilisearch
    // ignores updates that match the current state. Background-await so a
    // slow Meili boot doesn't delay the API's own readiness.
    this.indexPromise = this.bootstrap();
    void this.indexPromise
      .then(() => this.syncMonitoringDbSources())
      .catch((err) => {
        this.logger.warn(`search bootstrap failed: ${(err as Error).message}`);
      });
    // Keep the DB-backed monitoring kinds fresh without a manual reindex.
    this.monitoringTimer = setInterval(() => {
      void this.syncMonitoringDbSources().catch((err) =>
        this.logger.debug(`monitoring sync failed: ${(err as Error).message}`),
      );
    }, MONITORING_SYNC_MS);
  }

  onModuleDestroy(): void {
    if (this.monitoringTimer) clearInterval(this.monitoringTimer);
  }

  private async bootstrap(): Promise<Index> {
    if (!this.client) throw new Error("Meilisearch client not initialised");
    // createIndex returns immediately even if the index already exists; we
    // wrap it in a try/catch so the "already exists" task error doesn't fail
    // bootstrap.
    try {
      const task = await this.client.createIndex(INDEX_NAME, { primaryKey: "id" });
      await this.client.waitForTask(task.taskUid, { timeOutMs: 10_000 });
    } catch {
      // Index already exists — fine, fall through.
    }
    const idx = this.client.index<SearchDoc>(INDEX_NAME);
    await idx.updateFilterableAttributes([
      "kind",
      "ownerUserId",
      "visibility",
      "aclGroupIds",
      "tagIds",
    ]);
    await idx.updateSortableAttributes(["updatedAt"]);
    await idx.updateSearchableAttributes(["title", "body"]);
    return idx;
  }

  private async indexOrNull(): Promise<Index | null> {
    if (!this.client) return null;
    try {
      return (await this.indexPromise) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * `addDocuments` only *enqueues* the write — document-level errors (bad
   * primary key, schema mismatch) surface later when Meilisearch processes the
   * task, not from the call above. Without this check those failures are
   * completely silent. We await the task result in the background so indexing
   * stays non-blocking for the caller but a failure still gets logged.
   */
  private watchTask(taskUid: number, label: string): void {
    if (!this.client) return;
    const client = this.client;
    void (async () => {
      try {
        const task = await client.waitForTask(taskUid, { timeOutMs: 30_000 });
        if (task.status === "failed") {
          this.logger.warn(`${label} task failed: ${task.error?.message ?? "unknown error"}`);
        }
      } catch (err) {
        this.logger.warn(`${label} task status check failed: ${(err as Error).message}`);
      }
    })();
  }

  async upsert(doc: SearchDoc): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx) return;
    try {
      const task = await idx.addDocuments([doc]);
      this.watchTask(task.taskUid, `search.upsert ${doc.id}`);
    } catch (err) {
      this.logger.warn(`search.upsert ${doc.id} failed: ${(err as Error).message}`);
    }
  }

  async upsertMany(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const idx = await this.indexOrNull();
    if (!idx) return;
    try {
      const task = await idx.addDocuments(docs);
      this.watchTask(task.taskUid, `search.upsertMany (${docs.length})`);
    } catch (err) {
      this.logger.warn(`search.upsertMany (${docs.length}) failed: ${(err as Error).message}`);
    }
  }

  async remove(id: string): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx) return;
    try {
      await idx.deleteDocument(id);
    } catch (err) {
      this.logger.warn(`search.remove ${id} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Build a Meilisearch filter expression that scopes results to what the
   * caller is allowed to see across every kind. Mirrors the per-module
   * read checks so we never leak data through the search index.
   */
  async search(opts: {
    q: string;
    userId: string;
    userGroupIds: string[];
    canSeeAnyTicket: boolean;
    canSeeAnyWiki: boolean;
    /** Holds `monitors:read:any` — sees monitor / infra / cisco kinds. */
    canSeeMonitoring: boolean;
    /** Holds `unifi:read:any` — sees UniFi device / client kinds. */
    canSeeUnifi: boolean;
    kinds?: SearchKind[];
    tagIds?: string[];
    limit?: number;
  }): Promise<SearchResult[]> {
    const idx = await this.indexOrNull();
    if (!idx) return [];

    const orParts: string[] = [];

    // Tickets: own OR (tickets:read:any → all). We don't have a ticket
    // assignee column in the index yet, but the data-of-record check via the
    // controller still applies if a result is clicked through.
    if (opts.canSeeAnyTicket) {
      orParts.push(`kind = "ticket"`);
    } else {
      orParts.push(`(kind = "ticket" AND ownerUserId = "${opts.userId}")`);
    }

    // Notes: per-user only (no sharing in Phase 1).
    orParts.push(`(kind = "note" AND ownerUserId = "${opts.userId}")`);

    // Wiki: read:any → all; otherwise public, own, or any ACL group overlap.
    if (opts.canSeeAnyWiki) {
      orParts.push(`kind = "wiki"`);
    } else {
      const groupClause =
        opts.userGroupIds.length > 0
          ? ` OR aclGroupIds IN [${opts.userGroupIds.map((g) => `"${g}"`).join(",")}]`
          : "";
      orParts.push(
        `(kind = "wiki" AND (visibility = "public" OR ownerUserId = "${opts.userId}"${groupClause}))`,
      );
    }

    // Monitoring kinds (monitors, infra, cisco) are broadcast-visible to anyone
    // holding monitors:read:any; UniFi kinds ride unifi:read:any. Users without
    // the relevant permission simply never get those kinds in the filter, so
    // nothing leaks through the index (mirrors the per-module read checks).
    if (opts.canSeeMonitoring) {
      orParts.push(`kind IN [${MONITORING_KINDS.map((k) => `"${k}"`).join(",")}]`);
    }
    if (opts.canSeeUnifi) {
      orParts.push(`kind IN [${UNIFI_KINDS.map((k) => `"${k}"`).join(",")}]`);
    }

    let filter = `(${orParts.join(" OR ")})`;
    if (opts.kinds && opts.kinds.length > 0) {
      const allowed = opts.kinds.map((k) => `"${k}"`).join(",");
      filter = `${filter} AND kind IN [${allowed}]`;
    }
    if (opts.tagIds && opts.tagIds.length > 0) {
      const ts = opts.tagIds.map((t) => `"${t}"`).join(",");
      filter = `${filter} AND tagIds IN [${ts}]`;
    }

    try {
      const res = await idx.search<SearchDoc>(opts.q, {
        filter,
        limit: opts.limit ?? 20,
        sort: ["updatedAt:desc"],
        attributesToHighlight: ["title", "body"],
        highlightPreTag: "<mark>",
        highlightPostTag: "</mark>",
        cropLength: 60,
      });
      return res.hits as SearchResult[];
    } catch (err) {
      this.logger.warn(`search.search failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Dump everything for a kind — used by the reindex script. */
  async clear(): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx) return;
    await idx.deleteAllDocuments();
  }

  /**
   * Full reindex: clear the index, then walk every searchable source table
   * (tickets / notes / wiki / monitors) and re-upsert. Used by the admin
   * "Reindex Meilisearch" button — last-resort recovery when the index gets
   * out of sync (Meili wipe, mid-write crash, etc.).
   *
   * Walks tables in pages of 500 to keep memory bounded; emits a progress
   * shape the caller can return verbatim to the UI.
   */
  async reindexAll(): Promise<{
    tickets: number;
    notes: number;
    wikiPages: number;
    monitors: number;
    monitoring: number;
  }> {
    await this.clear();

    let countTickets = 0;
    let countNotes = 0;
    let countWiki = 0;

    // Tickets.
    {
      const rows = await this.db.select().from(tickets).orderBy(asc(tickets.id));
      const docs = rows.map((row) => ({
        id: searchDocId("ticket", row.id),
        kind: "ticket" as const,
        resourceId: row.id,
        ownerUserId: row.createdByUserId,
        title: row.title,
        body: row.description ?? "",
        extra: { number: row.number, status: row.status, priority: row.priority },
        url: `/tickets/${row.id}`,
        updatedAt: row.updatedAt.toISOString(),
      }));
      if (docs.length) await this.upsertMany(docs);
      countTickets = docs.length;
    }

    // Notes (private to owner — search filter still enforced at query time).
    {
      const rows = await this.db.select().from(notes).orderBy(asc(notes.id));
      const docs = rows.map((row) => ({
        id: searchDocId("note", row.id),
        kind: "note" as const,
        resourceId: row.id,
        ownerUserId: row.ownerUserId,
        title: row.title || "(untitled)",
        body: row.body,
        extra: { color: row.color, pinned: row.pinned, archived: row.archived },
        url: `/notes`,
        updatedAt: row.updatedAt.toISOString(),
      }));
      if (docs.length) await this.upsertMany(docs);
      countNotes = docs.length;
    }

    // Wiki — also pre-loads per-page ACL group ids for the search-time filter.
    {
      const [pageRows, aclRows] = await Promise.all([
        this.db.select().from(wikiPages).orderBy(asc(wikiPages.id)),
        this.db.select().from(wikiPageAcl),
      ]);
      const aclByPage = new Map<string, string[]>();
      for (const a of aclRows) {
        const cur = aclByPage.get(a.pageId) ?? [];
        cur.push(a.groupId);
        aclByPage.set(a.pageId, cur);
      }
      const docs = pageRows.map((row) => ({
        id: searchDocId("wiki", row.id),
        kind: "wiki" as const,
        resourceId: row.id,
        ownerUserId: row.ownerUserId,
        visibility: row.visibility as "public" | "group",
        aclGroupIds: row.visibility === "group" ? aclByPage.get(row.id) ?? [] : [],
        title: row.title,
        body: row.body ?? "",
        url: `/wiki/${row.id}`,
        updatedAt: row.updatedAt.toISOString(),
      }));
      if (docs.length) await this.upsertMany(docs);
      countWiki = docs.length;
    }

    // Monitoring (service monitors + infra + cisco). UniFi is pushed live by
    // the poller, so it isn't part of the batch walk — it stays current on its
    // own poll cadence.
    const monitoring = await this.syncMonitoringDbSources();

    return {
      tickets: countTickets,
      notes: countNotes,
      wikiPages: countWiki,
      monitors: monitoring.monitors,
      monitoring: monitoring.total,
    };
  }

  /** Timestamp helper — cache tables (cisco) carry no updatedAt, so freshness
   * is "now" each sync; DB entities use their own updatedAt where present. */
  private nowIso(): string {
    return new Date().toISOString();
  }

  /**
   * Build the searchable documents for every DB-backed monitoring source:
   * service monitors, infra targets + present entities, and the Cisco caches
   * (switches, ports, MAC table, ARP cache, VLAN DB). UniFi lives outside the
   * DB and is handled by `syncUnifi`.
   */
  private async buildMonitoringDbDocs(): Promise<SearchDoc[]> {
    const [monRows, targetRows, entityRows, switchRows, portRows, macRows, arpRows, vlanRows, ipamSubnetRows, ipamHostRows] =
      await Promise.all([
        this.db.select().from(monitors),
        this.db.select().from(infraTargets),
        this.db.select().from(infraEntities).where(eq(infraEntities.present, true)),
        this.db.select().from(ciscoSwitches),
        this.db.select().from(ciscoPorts),
        this.db.select().from(ciscoMacTable),
        this.db.select().from(ciscoArpCache),
        this.db.select().from(ciscoVlanDb),
        this.db.select().from(ipamSubnets),
        this.db.select().from(ipamHosts),
      ]);

    const swName = new Map(switchRows.map((s) => [s.id, s.hostname]));
    const now = this.nowIso();
    const docs: SearchDoc[] = [];

    for (const r of monRows) {
      docs.push({
        id: searchDocId("monitor", r.id),
        kind: "monitor",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: r.target,
        extra: { kind: r.kind, status: r.status },
        url: `/monitoring/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of targetRows) {
      docs.push({
        id: searchDocId("infra_target", r.id),
        kind: "infra_target",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: [r.host, r.kind, r.os].filter(Boolean).join(" · "),
        extra: { status: r.status, kind: r.kind },
        url: `/monitoring/infra/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of entityRows) {
      docs.push({
        id: searchDocId("infra_entity", r.id),
        kind: "infra_entity",
        resourceId: r.id,
        ownerUserId: null,
        title: r.name,
        body: [r.entityKind, r.groupKey, r.status].filter(Boolean).join(" · "),
        extra: { entityKind: r.entityKind, status: r.status, targetId: r.targetId },
        // Entities live under their parent target's detail page.
        url: `/monitoring/infra/${r.targetId}`,
        updatedAt: r.lastSeenAt.toISOString(),
      });
    }

    for (const r of switchRows) {
      docs.push({
        id: searchDocId("cisco_switch", r.id),
        kind: "cisco_switch",
        resourceId: r.id,
        ownerUserId: null,
        title: r.hostname,
        body: [r.ipAddress, r.model, r.location].filter(Boolean).join(" · "),
        extra: { reachable: r.reachable, model: r.model },
        url: `/monitoring/network-cisco/switches/${r.id}`,
        updatedAt: now,
      });
    }

    for (const r of portRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_port", r.id),
        kind: "cisco_port",
        resourceId: r.id,
        ownerUserId: null,
        title: [host, r.portId].filter(Boolean).join(" "),
        body: [r.description, `vlan ${r.accessVlan}`, r.neighborHostname].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, portId: r.portId },
        url: `/monitoring/network-cisco/switches/${r.switchId}`,
        updatedAt: now,
      });
    }

    for (const r of macRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_mac", r.id),
        kind: "cisco_mac",
        resourceId: r.id,
        ownerUserId: null,
        title: r.macAddress,
        body: [`vlan ${r.vlan ?? "?"}`, r.portId, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, vlan: r.vlan },
        url: `/monitoring/network-cisco/lookup`,
        updatedAt: now,
      });
    }

    for (const r of arpRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_arp", r.id),
        kind: "cisco_arp",
        resourceId: r.id,
        ownerUserId: null,
        title: r.ipAddress,
        body: [r.macAddress, r.rdnsName, r.interface, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, mac: r.macAddress },
        url: `/monitoring/network-cisco/lookup`,
        updatedAt: now,
      });
    }

    for (const r of vlanRows) {
      const host = swName.get(r.switchId) ?? "";
      docs.push({
        id: searchDocId("cisco_vlan", r.id),
        kind: "cisco_vlan",
        resourceId: r.id,
        ownerUserId: null,
        title: [`VLAN ${r.vlanId}`, r.vlanName].filter(Boolean).join(" "),
        body: [r.vlanStatus, host].filter(Boolean).join(" · "),
        extra: { switchId: r.switchId, vlanId: r.vlanId },
        url: `/monitoring/network-cisco/vlans`,
        updatedAt: now,
      });
    }

    for (const r of ipamSubnetRows) {
      docs.push({
        id: searchDocId("ipam_subnet", r.id),
        kind: "ipam_subnet",
        resourceId: r.id,
        ownerUserId: null,
        title: [r.cidr, r.label].filter(Boolean).join(" · "),
        body: [r.label, r.gateway, r.vlanId ? `vlan ${r.vlanId}` : null, r.source].filter(Boolean).join(" · "),
        extra: { source: r.source, scanEnabled: r.scanEnabled },
        url: `/monitoring/ipam/${r.id}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    for (const r of ipamHostRows) {
      docs.push({
        id: searchDocId("ipam_host", r.id),
        kind: "ipam_host",
        resourceId: r.id,
        ownerUserId: null,
        title: [r.ipAddress, r.unifiName].filter(Boolean).join(" · "),
        body: [r.unifiName, r.hostname, r.netbiosName, r.macAddress].filter(Boolean).join(" · "),
        extra: { subnetId: r.subnetId, isUp: r.isUp },
        url: `/monitoring/ipam/${r.subnetId}`,
        updatedAt: r.updatedAt.toISOString(),
      });
    }

    return docs;
  }

  /** Delete every indexed doc whose kind is in `kinds` (scoped clear). */
  private async deleteByKinds(kinds: SearchKind[]): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx || kinds.length === 0) return;
    const filter = `kind IN [${kinds.map((k) => `"${k}"`).join(",")}]`;
    try {
      const task = await idx.deleteDocuments({ filter });
      await this.client?.waitForTask(task.taskUid, { timeOutMs: 30_000 });
    } catch (err) {
      this.logger.warn(`search.deleteByKinds failed: ${(err as Error).message}`);
    }
  }

  /**
   * Reconcile the DB-backed monitoring kinds: clear them, then re-add the
   * current set. Called on startup, on a timer, and by reindexAll. Clearing by
   * kind (rather than the whole index) leaves tickets/notes/wiki/UniFi intact.
   */
  async syncMonitoringDbSources(): Promise<{ total: number; monitors: number }> {
    const idx = await this.indexOrNull();
    if (!idx) return { total: 0, monitors: 0 };
    const docs = await this.buildMonitoringDbDocs();
    await this.deleteByKinds(MONITORING_KINDS);
    if (docs.length) await this.upsertMany(docs);
    const monitors = docs.filter((d) => d.kind === "monitor").length;
    return { total: docs.length, monitors };
  }

  /**
   * Reconcile the live UniFi kinds from a poller snapshot. Devices/clients
   * aren't in the DB, so the UnifiPoller pushes the current set here each poll;
   * we clear the UniFi kinds and re-add. Keyed by MAC.
   */
  async syncUnifi(
    devices: Array<{ mac?: string; name?: string; model?: string; ip?: string; state?: number; type?: string }>,
    clients: Array<{ mac?: string; name?: string; hostname?: string; ip?: string; network?: string }>,
  ): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx) return;
    const now = this.nowIso();
    const docs: SearchDoc[] = [];
    for (const d of devices) {
      if (!d.mac) continue;
      docs.push({
        id: searchDocId("unifi_device", d.mac),
        kind: "unifi_device",
        resourceId: d.mac,
        ownerUserId: null,
        title: d.name || d.model || d.mac,
        body: [d.ip, d.model, d.mac, d.type].filter(Boolean).join(" · "),
        extra: { state: d.state, ip: d.ip },
        url: `/monitoring/network`,
        updatedAt: now,
      });
    }
    for (const c of clients) {
      if (!c.mac) continue;
      docs.push({
        id: searchDocId("unifi_client", c.mac),
        kind: "unifi_client",
        resourceId: c.mac,
        ownerUserId: null,
        title: c.name || c.hostname || c.mac,
        body: [c.ip, c.mac, c.network].filter(Boolean).join(" · "),
        extra: { ip: c.ip, network: c.network },
        url: `/monitoring/network`,
        updatedAt: now,
      });
    }
    await this.deleteByKinds(UNIFI_KINDS);
    if (docs.length) await this.upsertMany(docs);
  }
}
