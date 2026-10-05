import { Injectable, Inject, Logger, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { MeiliSearch, type Index } from "meilisearch";
import { ClusterBus, INTERNAL_ROOM_PREFIX } from "../cluster/cluster-bus.service";
import type { BusRow } from "../cluster/bus.store";
import { LIVE_SEARCH_STORE, type LiveSearchStore } from "./live-search.store";
import { diffDocs, withRev } from "./search-helpers";
import { SEARCH_SOURCES, type SearchSources } from "./search-sources";
import {
  CONTENT_KINDS,
  DNS_KINDS,
  LIVE_KINDS,
  MONITORING_KINDS,
  UNIFI_KINDS,
  searchDocId,
  type ContentKind,
  type SearchDoc,
  type SearchKind,
  type SearchResult,
} from "./search-types";

// The document shapes, kind lists and `searchDocId` live in search-types.ts and
// are re-exported so existing imports from this file keep working.
export * from "./search-types";

const INDEX_NAME = "content";

/** Internal bus channel carrying search change notices between nodes. */
export const SEARCH_ROOM = `${INTERNAL_ROOM_PREFIX}search`;

/**
 * Wraps the Meilisearch client. A single index (`content`) holds all kinds;
 * filterable attributes let us scope queries per request (per kind, owner,
 * ACL) without fanning out across indexes.
 *
 * Every node runs its own Meilisearch (it cannot be clustered), and each index
 * is derived entirely from the database, so any node can rebuild its own:
 *
 *  - Tickets, notes and wiki pages: a service that changes one calls `changed`.
 *    This node re-reads that resource from the database and updates its index
 *    at once; the other nodes are told over the cluster bus and do the same.
 *    A periodic reconcile heals anything the bus missed (an outage, a Meili wipe).
 *  - Monitoring kinds (monitors, infra, Cisco, IPAM): each node rebuilds them
 *    from the database on a timer.
 *  - Live kinds (UniFi, DNS): the one node that reads the source writes the
 *    current set to `live_search_docs` (`syncUnifi`, `syncDns`); every node
 *    reconciles its index from that table.
 *
 * "Reconcile" compares each indexed document's content hash (`rev`) with the
 * desired one and writes or deletes only the difference. Search is therefore
 * eventually consistent across nodes (about a second or two): something created
 * on one node may be missing from a search served by another for a moment.
 *
 * Indexing is best-effort and never blocks the caller: failures are logged but
 * the underlying mutation still succeeds. The data-of-record is the DB.
 */
// Periodic refresh of the DB-backed monitoring kinds (infra + cisco caches are
// written by their pollers; this picks up their churn without a manual reindex)
// and of the live kinds from their table (the backstop for a missed bus event).
const MONITORING_SYNC_MS = Math.max(
  60_000,
  parseInt(process.env.SEARCH_MONITORING_SYNC_MS ?? "120000", 10) || 120_000,
);
/** How often the content kinds are compared against the database in full. */
const CONTENT_RECONCILE_MS = Math.max(
  60_000,
  parseInt(process.env.SEARCH_CONTENT_RECONCILE_MS ?? "600000", 10) || 600_000,
);
/** A search waits at most this long for the start-up reconcile before answering anyway. */
const READY_WAIT_MS = 8_000;
const DELETE_CHUNK = 1_000;

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private client: MeiliSearch | null = null;
  private indexPromise: Promise<Index> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private contentTimer: ReturnType<typeof setInterval> | null = null;
  private offBus: (() => void) | null = null;
  /** Resolves when the first full reconcile has finished (or failed). */
  private initial: Promise<void> = Promise.resolve();
  private ready = false;
  /** Index-changing work runs one piece at a time, so reconciles never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(SEARCH_SOURCES) private readonly sources: SearchSources,
    @Inject(LIVE_SEARCH_STORE) private readonly live: LiveSearchStore,
    private readonly bus: ClusterBus,
  ) {}

  async onModuleInit(): Promise<void> {
    const host = process.env.MEILI_URL;
    if (!host) {
      this.logger.warn("MEILI_URL not set — search disabled");
      return;
    }
    this.client = new MeiliSearch({ host, apiKey: process.env.MEILI_MASTER_KEY });
    this.offBus = this.bus.onEvent((row) => this.onBusEvent(row));
    // Bootstrap the index + settings on startup. Idempotent — Meilisearch
    // ignores updates that match the current state. Background-await so a
    // slow Meili boot doesn't delay the API's own readiness.
    this.indexPromise = this.bootstrap();
    // Then bring the index in line with the database. A new or restarted node
    // starts from whatever its Meilisearch happened to hold (nothing, for a new
    // node); searches wait briefly for this (see search()).
    this.initial = this.indexPromise
      .then(() => this.reconcileEverything())
      .catch((err: unknown) => {
        this.logger.warn(`search bootstrap failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.ready = true;
      });
    this.syncTimer = setInterval(() => {
      void this.syncPeriodic().catch((err: unknown) =>
        this.logger.debug(`periodic search sync failed: ${(err as Error).message}`),
      );
    }, MONITORING_SYNC_MS);
    this.syncTimer.unref();
    this.contentTimer = setInterval(() => {
      void this.reconcileContent().catch((err: unknown) =>
        this.logger.debug(`content reconcile failed: ${(err as Error).message}`),
      );
    }, CONTENT_RECONCILE_MS);
    this.contentTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.contentTimer) clearInterval(this.contentTimer);
    this.offBus?.();
  }

  // ---- change notices from other nodes ----

  private onBusEvent(row: BusRow): void {
    if (row.room !== SEARCH_ROOM) return;
    const p = (row.payload ?? {}) as { kind?: string; id?: string };
    if (row.event === "changed") {
      if (typeof p.id === "string" && CONTENT_KINDS.includes(p.kind as ContentKind)) {
        void this.applyChange(p.kind as ContentKind, p.id);
      }
    } else if (row.event === "live") {
      void this.reconcileLive().catch((err: unknown) => this.logger.debug(`live reconcile failed: ${(err as Error).message}`));
    } else if (row.event === "reindex") {
      this.logger.log("reindex requested from another node");
      void this.reindexAll().catch((err: unknown) => this.logger.warn(`reindex failed: ${(err as Error).message}`));
    }
  }

  // ---- plumbing ----

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    await this.upsertMany([doc]);
  }

  async upsertMany(docs: SearchDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const idx = await this.indexOrNull();
    if (!idx) return;
    try {
      const task = await idx.addDocuments(docs.map(withRev));
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

  /** Dump everything for a kind — used by the reindex script. */
  async clear(): Promise<void> {
    const idx = await this.indexOrNull();
    if (!idx) return;
    await idx.deleteAllDocuments();
  }

  // ---- reconcile ----

  /** id -> rev for every indexed document of `kinds`. */
  private async existingRevs(idx: Index, kinds: SearchKind[]): Promise<Map<string, string | undefined>> {
    const filter = `kind IN [${kinds.map((k) => `"${k}"`).join(",")}]`;
    const out = new Map<string, string | undefined>();
    const limit = 1_000;
    for (let offset = 0; ; offset += limit) {
      const page = await idx.getDocuments<{ id: string; rev?: string }>({ filter, fields: ["id", "rev"], limit, offset });
      for (const d of page.results) out.set(d.id, d.rev);
      if (page.results.length < limit) break;
    }
    return out;
  }

  /**
   * Make the index hold exactly `desired` for `kinds`: write the documents whose
   * content hash differs, delete the ones that should not be there. Everything
   * else is left alone, so there is no window in which they vanish and reappear.
   */
  private async reconcileKinds(kinds: SearchKind[], desired: SearchDoc[]): Promise<{ upserted: number; deleted: number }> {
    const idx = await this.indexOrNull();
    if (!idx) return { upserted: 0, deleted: 0 };
    const { upserts, deletes } = diffDocs(await this.existingRevs(idx, kinds), desired);
    for (let i = 0; i < deletes.length; i += DELETE_CHUNK) {
      const task = await idx.deleteDocuments(deletes.slice(i, i + DELETE_CHUNK));
      this.watchTask(task.taskUid, `search.reconcile delete (${Math.min(DELETE_CHUNK, deletes.length - i)})`);
    }
    if (upserts.length) await this.upsertMany(upserts);
    return { upserted: upserts.length, deleted: deletes.length };
  }

  private async loadAllContent(): Promise<SearchDoc[]> {
    const parts = await Promise.all(CONTENT_KINDS.map((k) => this.sources.loadContentDocs(k)));
    return parts.flat();
  }

  private async reconcileEverything(): Promise<void> {
    await this.serial(async () => {
      const content = await this.reconcileKinds(CONTENT_KINDS, await this.loadAllContent());
      const monitoring = await this.reconcileKinds(MONITORING_KINDS, await this.sources.loadMonitoringDocs());
      const live = await this.reconcileKinds(LIVE_KINDS, await this.live.load(LIVE_KINDS));
      const n = (r: { upserted: number; deleted: number }) => `${r.upserted} written, ${r.deleted} removed`;
      this.logger.log(`search index reconciled: content ${n(content)}; monitoring ${n(monitoring)}; live ${n(live)}`);
    });
  }

  /** Compare tickets, notes and wiki pages against the database in full. */
  reconcileContent(): Promise<void> {
    return this.serial(async () => {
      await this.reconcileKinds(CONTENT_KINDS, await this.loadAllContent());
    });
  }

  /**
   * Reconcile the DB-backed monitoring kinds (service monitors, infra, Cisco,
   * IPAM). Called on startup, on a timer, and by reindexAll.
   */
  syncMonitoringDbSources(): Promise<{ total: number; monitors: number }> {
    return this.serial(async () => {
      const idx = await this.indexOrNull();
      if (!idx) return { total: 0, monitors: 0 };
      const docs = await this.sources.loadMonitoringDocs();
      await this.reconcileKinds(MONITORING_KINDS, docs);
      return { total: docs.length, monitors: docs.filter((d) => d.kind === "monitor").length };
    });
  }

  /** Bring the UniFi and DNS kinds in line with `live_search_docs`. */
  reconcileLive(): Promise<void> {
    return this.serial(async () => {
      await this.reconcileKinds(LIVE_KINDS, await this.live.load(LIVE_KINDS));
    });
  }

  private async syncPeriodic(): Promise<void> {
    await this.syncMonitoringDbSources();
    await this.reconcileLive();
  }

  // ---- content changes ----

  /**
   * A ticket, note or wiki page was created, edited, deleted or had its access
   * changed. Call after the database write. This node's index is updated from
   * the database right away (so the writer finds its own change), and the other
   * nodes are told to do the same. Deleting is "changed" too: the resource is
   * no longer there, so its document goes. Never throws.
   */
  async changed(kind: ContentKind, id: string): Promise<void> {
    this.bus.publish({ room: SEARCH_ROOM, event: "changed", payload: { kind, id } });
    await this.applyChange(kind, id);
  }

  private applyChange(kind: ContentKind, id: string): Promise<void> {
    return this.serial(async () => {
      try {
        if (!(await this.indexOrNull())) return;
        const doc = await this.sources.loadContentDoc(kind, id);
        if (doc) await this.upsertMany([doc]);
        else await this.remove(searchDocId(kind, id));
      } catch (err) {
        this.logger.warn(`search update for ${kind} ${id} failed: ${(err as Error).message}`);
      }
    });
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
    // A node that has only just started is still bringing its index up to date;
    // wait a few seconds for that rather than answer from a half-built index.
    if (!this.ready) await Promise.race([this.initial, new Promise((r) => setTimeout(r, READY_WAIT_MS))]);

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
      const kinds = [...MONITORING_KINDS, ...DNS_KINDS];
      orParts.push(`kind IN [${kinds.map((k) => `"${k}"`).join(",")}]`);
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


  /** Dump and rebuild this node's index from the database. */
  reindexAll(): Promise<{
    tickets: number;
    notes: number;
    wikiPages: number;
    monitors: number;
    monitoring: number;
  }> {
    return this.serial(async () => {
      await this.clear();
      const counts = { tickets: 0, notes: 0, wikiPages: 0, monitors: 0, monitoring: 0 };
      const byKind: Record<ContentKind, "tickets" | "notes" | "wikiPages"> = {
        ticket: "tickets",
        note: "notes",
        wiki: "wikiPages",
      };
      for (const kind of CONTENT_KINDS) {
        const docs = await this.sources.loadContentDocs(kind);
        await this.upsertMany(docs);
        counts[byKind[kind]] = docs.length;
      }
      const monitoring = await this.sources.loadMonitoringDocs();
      await this.upsertMany(monitoring);
      counts.monitoring = monitoring.length;
      counts.monitors = monitoring.filter((d) => d.kind === "monitor").length;
      // UniFi and DNS documents come back from their table, not from waiting for the next poll.
      await this.upsertMany(await this.live.load(LIVE_KINDS));
      return counts;
    });
  }

  /**
   * Admin "Reindex": rebuild this node's index and ask every other node to
   * rebuild theirs. Returns this node's counts.
   */
  async reindexEverywhere(): ReturnType<SearchService["reindexAll"]> {
    this.bus.publish({ room: SEARCH_ROOM, event: "reindex" });
    return this.reindexAll();
  }

  // ---- live kinds (not in the database) ----

  /**
   * Write the current set of `kinds` to the shared table and, if it changed, tell
   * the other nodes. Writes only the rows whose content changed. Then bring this
   * node's own index in line.
   */
  private async publishLive(kinds: SearchKind[], docs: SearchDoc[]): Promise<void> {
    const changed = await this.live.replace(kinds, docs);
    if (!changed) return;
    this.bus.publish({ room: SEARCH_ROOM, event: "live", payload: { kinds } });
    await this.reconcileLive();
  }

  /**
   * Publish the live UniFi kinds from a poller snapshot. Devices/clients aren't
   * in the DB, so the one node running the UnifiPoller pushes the current set
   * here each poll. Keyed by MAC.
   */
  async syncUnifi(
    devices: Array<{ mac?: string; name?: string; model?: string; ip?: string; state?: number; type?: string }>,
    clients: Array<{ mac?: string; name?: string; hostname?: string; ip?: string; network?: string }>,
  ): Promise<void> {
    const now = new Date().toISOString();
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
    await this.publishLive(UNIFI_KINDS, docs);
  }

  /**
   * Publish every DNS record (built by the DNS module's indexer from a full read
   * of the Technitium zones) as the current set.
   */
  async syncDns(docs: SearchDoc[]): Promise<void> {
    await this.publishLive(DNS_KINDS, docs);
  }
}
