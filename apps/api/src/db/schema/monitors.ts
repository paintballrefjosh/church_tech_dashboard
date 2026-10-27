import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { infraTargets } from "./infra";
import { serviceGroups } from "./service-monitoring";
import { users } from "./users";
import { wikiPages } from "./wiki";
import { locations } from "./assets";

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
    // A probe worker takes a monitor by setting this a minute ahead, so with several
    // nodes each monitor is probed by one at a time; it is cleared when the check is
    // recorded, and a worker that dies mid-probe only delays the check by that minute.
    claimedUntil: timestamp("claimed_until", { withTimezone: true }),
    // NODE_ID of the node whose probe worker recorded the latest check. Null before the first check,
    // or for a check made by a release that did not record it.
    lastCheckedBy: text("last_checked_by"),
    lastLatencyMs: integer("last_latency_ms"),
    consecutiveFails: integer("consecutive_fails").notNull().default(0),
    consecutiveOks: integer("consecutive_oks").notNull().default(0),

    // Set by the probe worker while the monitor keeps going down and up (alert-rules.ts `isFlapping`): its individual
    // down/up notices are held back until it has stayed in one state for the flap window.
    flappingSince: timestamp("flapping_since"),
    // Listed on the status page every signed-in person can read, under `statusName` when there is one.
    showOnStatus: boolean("show_on_status").notNull().default(false),
    statusName: text("status_name"),
    // The wiki page that says what to do when it fails, shown on the monitor's page (the title only to people who may read it).
    runbookPageId: uuid("runbook_page_id").references(() => wikiPages.id, { onDelete: "set null" }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    enabledIdx: index("monitors_enabled_idx").on(t.enabled),
  }),
);

/**
 * Append-only per-check log. Kept lean (id, monitor, ts, ok, latency, info)
 * so we can show a sparkline without dragging blobs around. The probe worker
 * prunes rows older than MONITOR_PRUNE_DAYS in batches, through the `ts` index.
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
    // NODE_ID of the node whose probe worker made this check (null for checks from before it was recorded).
    nodeId: text("node_id"),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (t) => ({
    monitorTsIdx: index("monitor_checks_monitor_ts_idx").on(t.monitorId, t.ts),
    tsIdx: index("monitor_checks_ts_idx").on(t.ts),
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
    // Or a service group (migration 0087): one open incident per group and rule is the database's rule.
    serviceGroupId: uuid("service_group_id").references(() => serviceGroups.id, { onDelete: "cascade" }),
    ruleId: text("rule_id"), // infra threshold rule id that fired (null for up/down)
    /** A service group's incident: its rule id while open, NULL once resolved (the unique index below holds one open per rule). */
    groupOpenRule: text("group_open_rule"),
    detail: jsonb("detail"), // infra: { metric, threshold, observed }
    startedAt: timestamp("started_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    reason: text("reason"), // first-failure info string captured at open
    // Somebody has taken it: escalation stops. Ended by resolving, never cleared.
    acknowledgedAt: timestamp("acknowledged_at"),
    acknowledgedBy: uuid("acknowledged_by").references(() => users.id, { onDelete: "set null" }),
    // How far the escalation job has got (0 nothing, 1 reminder, 2 second group) and when it last sent.
    escalationLevel: integer("escalation_level").notNull().default(0),
    escalatedAt: timestamp("escalated_at"),
  },
  (t) => ({
    openIdx: index("monitor_incidents_open_idx").on(t.monitorId, t.resolvedAt),
    targetOpenIdx: index("monitor_incidents_target_open_idx").on(t.targetId, t.resolvedAt),
    groupOpenIdx: uniqueIndex("monitor_incidents_group_open_idx")
      .on(t.serviceGroupId, t.groupOpenRule),
  }),
);
