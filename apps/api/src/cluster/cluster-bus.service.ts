import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { BUS_STORE, type BusRow, type BusStore } from "./bus.store";
import { ClusterJobs } from "./cluster-jobs.service";
import { NodeService } from "./node.service";

/** How often each node looks for events published by the others. */
export const BUS_POLL_MS = 1_000;
/** Published events are written in batches this often. */
const FLUSH_MS = 100;
/**
 * A poll looks back this far before the previous one, so an event whose insert
 * committed a little after a later one's is still seen. Duplicates from the
 * overlap are dropped by id.
 */
const OVERLAP_MS = 5_000;
/** How long a processed event id is remembered (comfortably longer than the overlap). */
const SEEN_TTL_MS = 30_000;
/** Rows older than this are deleted. */
const EVENT_TTL_SEC = 60;
const PRESENCE_EVERY_MS = 5_000;
/** A node's presence rows are believed for this long after its last refresh. */
const PRESENCE_MAX_AGE_SEC = 20;
const FETCH_LIMIT = 1_000;
/** Rows per INSERT, so one batch always fits inside one fetch page. */
const INSERT_CHUNK = 200;
/** An event bigger than this is delivered on this node only (see publish). */
export const MAX_EVENT_BYTES = 512_000;
const MAX_BUFFER = 5_000;
/**
 * Allowance for the nodes' clocks differing a little (NTP keeps them within milliseconds): a poll counts
 * as "after" a moment only if it started this much later.
 */
const SYNC_SKEW_MS = 250;
/** The longest a request waits for a forced poll before carrying on with what it has. */
const SYNC_MAX_WAIT_MS = 1_500;

/** Rooms starting with this are internal channels, not Socket.IO rooms. */
export const INTERNAL_ROOM_PREFIX = "__";

/** Internal channel for dropping another node's in-memory caches. */
export const CACHE_ROOM = `${INTERNAL_ROOM_PREFIX}cache`;

export type BusHandler = (row: BusRow) => void | Promise<void>;

export interface PublishInput {
  room: string;
  event: string;
  payload?: unknown;
  /** Names a live snapshot that holds the payload (see publishSnapshot). */
  ref?: string;
}

/**
 * Event channel between app nodes, over the database (this replaced the Redis
 * Socket.IO adapter; docs/multi-node.md). A node publishes by inserting rows;
 * every node polls about once a second for rows from the others and hands them
 * to its handlers. A node never receives its own events back (it delivers those
 * locally when it publishes).
 *
 * Also carries which rooms have viewers on which node (presence), and the latest
 * copy of payloads too large to send on every change (snapshots).
 *
 * Delivery is best effort, like the Redis pub/sub it replaced: an event can be
 * lost if the database is unreachable for longer than the retention window.
 * Nothing stored depends on it; browsers refetch on reconnect.
 */
@Injectable()
export class ClusterBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClusterBus.name);
  private readonly handlers = new Set<BusHandler>();
  private readonly seen = new Map<string, number>();
  private buffer: Array<Omit<BusRow, "ts">> = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private seq = 0;
  /** Database time of the first poll: events before it are not this node's to deliver. */
  private startedAt: Date | null = null;
  private since: Date | null = null;
  /** The last poll returned a full page: continue exactly where it ended, with no look-back. */
  private resume = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private presenceTimer: NodeJS.Timeout | null = null;
  private presenceSoon: NodeJS.Timeout | null = null;
  private presenceSource: (() => Map<string, number>) | null = null;
  private lastPresence: string | null = null;
  private lastPresenceAt = 0;
  private remote = new Map<string, number>();
  private stopped = false;
  private failing = false;
  /** Wall clock (this node's) at which the latest poll began. */
  private lastPollStartedAt = 0;
  private inflight: Promise<boolean> | null = null;

  constructor(
    @Inject(BUS_STORE) private readonly store: BusStore,
    private readonly node: NodeService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.arm();
    this.presenceTimer = setInterval(() => void this.writePresence(), PRESENCE_EVERY_MS);
    this.presenceTimer.unref();
    this.jobs.register({
      name: "bus-prune",
      everyMs: 30_000,
      initialDelayMs: 30_000,
      run: () => this.store.prune(EVENT_TTL_SEC),
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    for (const t of [this.pollTimer, this.presenceTimer, this.flushTimer, this.presenceSoon]) if (t) clearTimeout(t);
    await this.flush().catch(() => undefined);
    // Leave no presence behind: this node's viewers are gone with it.
    await this.store.writePresence(this.node.identity.nodeId, new Map()).catch(() => undefined);
  }

  /** Register a receiver of events from other nodes. Returns an unsubscribe function. */
  onEvent(handler: BusHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Send an event to the other nodes. Returns at once; the write is batched.
   * An event over {@link MAX_EVENT_BYTES} is not sent (and logged): put big
   * payloads in a snapshot and publish a `ref`.
   */
  publish(input: PublishInput): void {
    if (this.stopped) return;
    const payload = input.payload === undefined ? null : input.payload;
    if (payload !== null && JSON.stringify(payload).length > MAX_EVENT_BYTES) {
      this.logger.warn(`event ${input.event} for ${input.room} is too large to send to other nodes; delivered locally only`);
      return;
    }
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.logger.warn("event buffer full; dropped the oldest event");
    }
    this.buffer.push({
      id: randomUUID(),
      originNode: this.node.identity.holder,
      seq: ++this.seq,
      room: input.room,
      event: input.event,
      payload,
      ref: input.ref ?? null,
    });
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_MS);
      this.flushTimer.unref();
    }
  }

  /** Store a large payload as the current copy of `kind`, then announce it to the other nodes. */
  async publishSnapshot(room: string, event: string, kind: string, payload: unknown): Promise<void> {
    await this.store.writeSnapshot(kind, payload);
    this.publish({ room, event, ref: kind });
  }

  readSnapshot(kind: string): Promise<unknown | null> {
    return this.store.readSnapshot(kind);
  }

  /** Whether any other node has browsers connected to `room`, as of the last poll. */
  remoteViewers(room: string): boolean {
    return (this.remote.get(room) ?? 0) > 0;
  }

  /**
   * Where to read this node's own room sizes from (the gateway). Presence is
   * written every few seconds, and soon after {@link touchPresence}.
   */
  setPresenceSource(fn: () => Map<string, number>): void {
    this.presenceSource = fn;
  }

  /** A client subscribed or left: write presence soon rather than at the next tick. */
  touchPresence(): void {
    if (this.presenceSoon || this.stopped) return;
    this.presenceSoon = setTimeout(() => {
      this.presenceSoon = null;
      void this.writePresence();
    }, 250);
    this.presenceSoon.unref();
  }

  /** Write what has been published so far, now, rather than at the next batch tick. */
  async flushNow(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    await this.flush();
  }

  /**
   * Make sure events other nodes wrote before `sinceMs` (wall clock) have been delivered here.
   * That is what lets a user read their own write on a different node: the node that took the
   * write publishes its cache invalidations (and flushes them before answering); the user's next
   * request, which may land on another node, carries the time of that write and calls this, so
   * the stale cache entry is gone before it is read. Costs nothing when a poll started since; at
   * most one extra query otherwise, shared by every request waiting. Gives up after a moment
   * rather than hold a request up.
   */
  async syncSince(sinceMs: number): Promise<void> {
    if (this.stopped) return;
    const need = sinceMs + SYNC_SKEW_MS;
    if (this.lastPollStartedAt > need) return;
    const work = (async () => {
      if (this.inflight) await this.inflight.catch(() => undefined);
      if (this.lastPollStartedAt > need) return;
      await this.runPoll();
    })();
    await Promise.race([work, new Promise<void>((resolve) => setTimeout(resolve, SYNC_MAX_WAIT_MS).unref())]);
  }

  // ---- internals ----

  private arm(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => void this.poll(), BUS_POLL_MS);
    this.pollTimer.unref();
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    const rows = this.buffer;
    this.buffer = [];
    if (rows.length === 0) return;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      try {
        await this.store.insert(chunk);
      } catch (err) {
        this.logger.warn(`could not publish ${chunk.length} event(s): ${(err as Error).message}`);
      }
    }
  }

  private async writePresence(): Promise<void> {
    if (!this.presenceSource) return;
    const rooms = this.presenceSource();
    const key = JSON.stringify([...rooms].sort());
    const now = Date.now();
    // Idle and unchanged: nothing to say. Otherwise refresh at least every tick so it stays fresh.
    if (rooms.size === 0 && this.lastPresence === key) return;
    if (this.lastPresence === key && now - this.lastPresenceAt < PRESENCE_EVERY_MS - 500) return;
    try {
      await this.store.writePresence(this.node.identity.nodeId, rooms);
      this.lastPresence = key;
      this.lastPresenceAt = now;
    } catch (err) {
      this.logger.debug(`presence write failed: ${(err as Error).message}`);
    }
  }

  /** The timer's poll: one round, then the next is scheduled (straight away when a page was full). */
  private async poll(): Promise<void> {
    let more = false;
    try {
      more = await this.runPoll();
    } finally {
      if (more) void this.poll();
      else this.arm();
    }
  }

  /** One round of fetching and delivering, one at a time. True when the page was full and there is more. */
  private runPoll(): Promise<boolean> {
    if (this.inflight) return this.inflight;
    const p = this.pollOnce().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private async pollOnce(): Promise<boolean> {
    let more = false;
    this.lastPollStartedAt = Date.now();
    try {
      const dbNow = await this.store.now();
      // Only what happens after this node started, so a restarted node does not
      // replay recent events to browsers that just reconnected. Past that, look
      // back a little (see OVERLAP_MS); when continuing a full page, restart at its last row (1 ms
      // earlier, so rows sharing its timestamp are not skipped; ids de-duplicate).
      if (this.startedAt === null) this.startedAt = dbNow;
      const base = (this.since ?? dbNow).getTime();
      // Never reach back past this node's own start.
      const from = new Date(Math.max(this.startedAt.getTime(), this.resume ? base - 1 : base - OVERLAP_MS));
      const rows = await this.store.fetch(from, this.node.identity.holder, FETCH_LIMIT);
      more = rows.length >= FETCH_LIMIT;
      this.resume = more;
      // A full page means there may be more past it: continue from its last row, not from "now".
      this.since = more ? rows[rows.length - 1]!.ts : dbNow;

      const t = Date.now();
      for (const row of rows) {
        if (this.seen.has(row.id)) continue;
        this.seen.set(row.id, t);
        await this.dispatch(row);
      }
      for (const [id, at] of this.seen) if (t - at > SEEN_TTL_MS) this.seen.delete(id);

      this.remote = await this.store.readPresence(this.node.identity.nodeId, PRESENCE_MAX_AGE_SEC);
      if (this.failing) this.logger.log("event channel recovered");
      this.failing = false;
    } catch (err) {
      if (!this.failing) this.logger.warn(`event poll failed: ${(err as Error).message}`);
      this.failing = true;
    }
    return more;
  }

  private async dispatch(row: BusRow): Promise<void> {
    for (const h of this.handlers) {
      try {
        await h(row);
      } catch (err) {
        this.logger.warn(`handler for ${row.event} failed: ${(err as Error).message}`);
      }
    }
  }
}
