import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { infraTargets } from "./infra";

/**
 * A user-defined monitor. The probe worker reads the active set on a poll and
 * issues a single check at the configured `intervalSec`. Per-kind options
 * (HTTP method, expected status, timeout, body match, etc.) live in
 * `options` as a JSON blob — keeps the table flat and lets the catalogue
 * grow without DDL.
 *
 * The three "current state" columns (status, lastCheckedAt, consecutiveFails)
 * are denormalised onto this row so the list view can render without joining
 * the high-volume checks table. The probe worker is the only writer.
 */
export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // "http" | "tcp" | "icmp"
    target: text("target").notNull(), // url for http, host[:port] for tcp, host for icmp
    intervalSec: integer("interval_sec").notNull().default(60),
    // Consecutive failed checks before we open an incident.
    failThreshold: integer("fail_threshold").notNull().default(2),
    // Consecutive successful checks before we close an open incident.
    recoverThreshold: integer("recover_threshold").notNull().default(2),
    options: jsonb("options").notNull().default({}),
    enabled: boolean("enabled").notNull().default(true),

    // Denormalised current state. Defaults: status "unknown" (no checks yet).
    status: text("status").notNull().default("unknown"), // "up" | "down" | "unknown"
    lastCheckedAt: timestamp("last_checked_at"),
    lastLatencyMs: integer("last_latency_ms"),
    consecutiveFails: integer("consecutive_fails").notNull().default(0),
    consecutiveOks: integer("consecutive_oks").notNull().default(0),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    enabledIdx: index("monitors_enabled_idx").on(t.enabled),
  }),
);

/**
 * Append-only per-check log. Kept lean (id, monitor, ts, ok, latency, info)
 * so we can show a sparkline without dragging blobs around. A periodic
 * pruning job can trim rows older than N days — out of scope for v1.
 */
export const monitorChecks = pgTable(
  "monitor_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    ok: boolean("ok").notNull(),
    latencyMs: integer("latency_ms"),
    info: text("info"), // e.g. "200 OK" / "ECONNREFUSED" / "timeout"
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (t) => ({
    monitorTsIdx: index("monitor_checks_monitor_ts_idx").on(t.monitorId, t.ts),
  }),
);

/**
 * State-change records, shared by up/down monitors AND infrastructure threshold
 * alerts (so the incident/notification/activity feed stays unified). For a
 * monitor: a row is inserted when it crosses fail_threshold consecutive
 * failures (status → down); `resolvedAt` is set when it later recovers. For an
 * infra target: a row is inserted when a threshold rule breaches for its
 * sustained window, carrying the `ruleId` + `detail` (metric/threshold/observed).
 *
 * Exactly one of `monitorId` / `targetId` is set (enforced at the app layer).
 */
export const monitorIncidents = pgTable(
  "monitor_incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Nullable now: an incident belongs to a monitor OR an infra target.
    monitorId: uuid("monitor_id").references(() => monitors.id, { onDelete: "cascade" }),
    targetId: uuid("target_id").references(() => infraTargets.id, { onDelete: "cascade" }),
    ruleId: text("rule_id"), // infra threshold rule id that fired (null for up/down)
    detail: jsonb("detail"), // infra: { metric, threshold, observed }
    startedAt: timestamp("started_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    reason: text("reason"), // first-failure info string captured at open
  },
  (t) => ({
    openIdx: index("monitor_incidents_open_idx").on(t.monitorId, t.resolvedAt),
    targetOpenIdx: index("monitor_incidents_target_open_idx").on(t.targetId, t.resolvedAt),
  }),
);
