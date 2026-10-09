/**
 * Drizzle schema mirror for the monitor service. We deliberately re-declare
 * the columns we touch here rather than depending on the api app (apps are
 * not importable packages). Keep this in sync with apps/api/src/db/schema.
 */
import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  boolean,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

export const monitors = pgTable("monitors", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  target: text("target").notNull(),
  intervalSec: integer("interval_sec").notNull(),
  failThreshold: integer("fail_threshold").notNull(),
  recoverThreshold: integer("recover_threshold").notNull(),
  options: jsonb("options").notNull(),
  enabled: boolean("enabled").notNull(),
  status: text("status").notNull(),
  lastCheckedAt: timestamp("last_checked_at"),
  claimedUntil: timestamp("claimed_until", { withTimezone: true }),
  lastCheckedBy: text("last_checked_by"),
  lastLatencyMs: integer("last_latency_ms"),
  consecutiveFails: integer("consecutive_fails").notNull(),
  consecutiveOks: integer("consecutive_oks").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const monitorChecks = pgTable("monitor_checks", {
  id: uuid("id").defaultRandom().primaryKey(),
  monitorId: uuid("monitor_id").notNull(),
  ok: boolean("ok").notNull(),
  latencyMs: integer("latency_ms"),
  info: text("info"),
  nodeId: text("node_id"),
  ts: timestamp("ts").notNull(),
});

export const monitorIncidents = pgTable("monitor_incidents", {
  id: uuid("id").defaultRandom().primaryKey(),
  monitorId: uuid("monitor_id").notNull(),
  startedAt: timestamp("started_at").notNull(),
  resolvedAt: timestamp("resolved_at"),
  reason: text("reason"),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipientUserId: uuid("recipient_user_id").notNull(),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  link: text("link"),
  readAt: timestamp("read_at"),
  createdAt: timestamp("created_at").notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  mutedNotificationKinds: text("muted_notification_kinds").array().notNull(),
  isActive: boolean("is_active").notNull(),
  deletedAt: timestamp("deleted_at"),
});

// Access model: (module, tier) per group — the legacy role/permission tables
// (user_roles/roles/role_permissions) are dead (migrations 0022/0024, see
// CLAUDE.md ## Access control) and are never read here anymore.
export const groups = pgTable("groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
});

export const groupMemberships = pgTable(
  "group_memberships",
  {
    groupId: uuid("group_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

export const groupModuleAccess = pgTable(
  "group_module_access",
  {
    groupId: uuid("group_id").notNull(),
    moduleKey: text("module_key").notNull(),
    tier: text("tier").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.moduleKey] }) }),
);

// Only the one key this worker reads (monitoring.maintenance_mode).
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const activityEvents = pgTable("activity_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorUserId: uuid("actor_user_id"),
  actorEmail: text("actor_email"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: uuid("resource_id"),
  title: text("title").notNull(),
  summary: text("summary"),
  link: text("link"),
  ts: timestamp("ts").notNull(),
});
