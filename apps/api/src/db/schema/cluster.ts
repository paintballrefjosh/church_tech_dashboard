import { pgTable, text, timestamp, integer, bigint, jsonb, primaryKey, index, uuid } from "drizzle-orm/pg-core";

/**
 * Coordination tables for running more than one app node against one database
 * (docs/multi-node.md). On a single node they are written and read but never
 * contended: the one node always holds every lease.
 *
 * All timestamps here are timestamptz and every comparison against "now" uses
 * the database's clock (`now()`), never the node's, so skewed node clocks
 * cannot make two nodes both believe they hold a lease.
 */

/** One row per live app process, refreshed by a heartbeat. */
export const clusterNodes = pgTable("cluster_nodes", {
  /** `NODE_ID` (default: hostname). Stable across restarts. */
  id: text("id").primaryKey(),
  /** Random per process lifetime; tells a restarted node from its old self. */
  instanceId: text("instance_id").notNull(),
  /** `full` (app + data services) or `data` (witness: database/object store only). */
  role: text("role").notNull().default("full"),
  /** Address other nodes use to reach this one, when configured. */
  addr: text("addr"),
  version: text("version"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Named leases. `job:<name>` leases elect which node runs a periodic job;
 * `mutex:<name>` leases serialise a piece of work that any node may start.
 * `epoch` increases every time the holder changes (fencing token).
 */
export const clusterLeases = pgTable("cluster_leases", {
  name: text("name").primaryKey(),
  /** `<node id>/<instance id prefix>` of the process that holds it. */
  holder: text("holder").notNull(),
  epoch: integer("epoch").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/**
 * Small pieces of state a job keeps between runs that must survive the job
 * moving to another node (alert baselines, consecutive-failure counters).
 * Not for bulk data.
 */
export const jobState = pgTable(
  "job_state",
  {
    job: text("job").notNull(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.job, t.key] }),
  }),
);

/**
 * Cross-node realtime: what a node publishes for the browsers connected to the
 * others (this replaced the Redis Socket.IO adapter). Rows live about a minute
 * and are pruned; every node polls for rows from other nodes about once a
 * second. `room` is a Socket.IO room (`user:<id>`, `network`, ...) or, when it
 * starts with `__`, an internal channel such as cache invalidation.
 *
 * Order is (ts, origin_node, seq): `ts` is the database clock at insert, and a
 * batch shares one `ts`, so `seq` (a per-process counter) keeps a node's own
 * events in the order it published them.
 */
export const realtimeEvents = pgTable(
  "realtime_events",
  {
    id: uuid("id").primaryKey(),
    originNode: text("origin_node").notNull(),
    seq: bigint("seq", { mode: "number" }).notNull(),
    room: text("room").notNull(),
    event: text("event").notNull(),
    /** Null when `ref` points at a live_snapshots row holding the (large) payload. */
    payload: jsonb("payload"),
    ref: text("ref"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tsIdx: index("realtime_events_ts_idx").on(t.ts),
  }),
);

/**
 * Which rooms have browsers connected, per node, so a job on one node can tell
 * whether anyone on any node is watching (the UniFi poller skips work when
 * nobody is). Refreshed every few seconds and whenever a client subscribes;
 * rows from a node that stopped refreshing are ignored and pruned.
 */
export const realtimePresence = pgTable(
  "realtime_presence",
  {
    nodeId: text("node_id").notNull(),
    room: text("room").notNull(),
    sockets: integer("sockets").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.nodeId, t.room] }),
  }),
);

/**
 * The latest copy of a payload too big to push through `realtime_events` on
 * every change (the UniFi network snapshot). One row per kind, overwritten.
 */
export const liveSnapshots = pgTable("live_snapshots", {
  kind: text("kind").primaryKey(),
  payload: jsonb("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Outgoing email waiting to be sent or retried (this replaced the BullMQ queue
 * in Redis). Any node may claim a row: a claim sets `claimed_until`, so a node
 * that dies mid-send only delays that mail by the claim window. Sent rows are
 * deleted; rows that fail every attempt stay as `failed` for a day.
 */
export const mailOutbox = pgTable(
  "mail_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    message: jsonb("message").notNull(),
    /** `pending` | `failed` (sent rows are deleted). */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index("mail_outbox_due_idx").on(t.status, t.nextAttemptAt),
  }),
);

/**
 * Counters for the strict (sign-in, TOTP, password change) rate limits, shared
 * by every node so the limit does not grow with the node count. The general
 * per-IP limit stays per node. Keys are `<method>:<route>|<client ip>`.
 */
export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The current set of searchable documents that do not come from this database
 * (UniFi devices and clients, DNS records), as last written by the one node that
 * read them from their source. Every node reconciles its own search index from
 * this table, so a node does not need to reach the UniFi controller or the DNS
 * server to search them. `rev` is a hash of the document's content, so a write
 * only touches the rows that changed.
 */
export const liveSearchDocs = pgTable(
  "live_search_docs",
  {
    kind: text("kind").notNull(),
    docId: text("doc_id").notNull(),
    rev: text("rev").notNull(),
    doc: jsonb("doc").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.kind, t.docId] }),
  }),
);
