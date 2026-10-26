import { pgTable, text, boolean, timestamp, uuid, integer, jsonb, index, uniqueIndex, primaryKey, doublePrecision } from "drizzle-orm/pg-core";
import { users } from "./users";
import { infraTargets } from "./infra";

/**
 * Service monitoring templates (docs/service-monitoring.md, migration 0085). Built-in templates live in code
 * (`BUILTIN_TEMPLATES` in packages/shared); this table holds custom ones and forks only, keyed by a slug that never
 * takes a built-in's key. `runs_commands` = the template has an ssh collector (saving it needed a confirmation).
 */
export const serviceTemplates = pgTable("service_templates", {
  key: text("key").primaryKey(),
  forkedFrom: text("forked_from"),
  body: jsonb("body").notNull(),
  runsCommands: boolean("runs_commands").notNull().default(false),
  version: integer("version").notNull().default(1),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** A named login (one `monitor` database user for every PostgreSQL server). The password is encrypted, never returned. */
export const serviceLogins = pgTable(
  "service_logins",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    passwordEnc: text("password_enc"),
    note: text("note").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ nameIdx: uniqueIndex("service_logins_name_idx").on(t.name) }),
);

/**
 * A template attached to a host. `inputs` holds the plain values (a login input holds `{loginId}`), `secrets_enc` the
 * encrypted `secret` inputs by key. The second block is written by the `service-poll` job (volatile in the backup
 * registry); `alert_state` is the per-check breach state (`stepCheckAlerts`) and `counters` the previous counter readings.
 */
export const serviceInstances = pgTable(
  "service_instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    targetId: uuid("target_id")
      .notNull()
      .references(() => infraTargets.id, { onDelete: "cascade" }),
    templateKey: text("template_key").notNull(),
    name: text("name").notNull(),
    inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull().default({}),
    secretsEnc: jsonb("secrets_enc").$type<Record<string, string>>().notNull().default({}),
    intervalSec: integer("interval_sec").notNull().default(60),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),

    status: text("status").notNull().default("unknown"),
    lastError: text("last_error"),
    lastPolledAt: timestamp("last_polled_at"),
    claimedUntil: timestamp("claimed_until"),
    lastValues: jsonb("last_values").$type<Record<string, number | null>>(),
    lastStates: jsonb("last_states").$type<Record<string, string | null>>(),
    members: jsonb("members"),
    membersOmitted: integer("members_omitted").notNull().default(0),
    checks: jsonb("checks"),
    collectorErrors: jsonb("collector_errors").$type<Record<string, string>>(),
    counters: jsonb("counters"),
    alertState: jsonb("alert_state"),
  },
  (t) => ({ targetIdx: index("service_instances_target_idx").on(t.targetId) }),
);

/** One row per instance per poll: every numeric metric by key. Kept 7 days; rollups keep longer (same windows as infra). */
export const serviceMetricSamples = pgTable(
  "service_metric_samples",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => serviceInstances.id, { onDelete: "cascade" }),
    ts: timestamp("ts").notNull().defaultNow(),
    values: jsonb("values").$type<Record<string, number>>().notNull().default({}),
  },
  (t) => ({
    pk: primaryKey({ name: "service_metric_samples_pk", columns: [t.instanceId, t.ts] }),
    tsIdx: index("service_metric_samples_ts_idx").on(t.ts),
  }),
);

/** 5m and 1h min/avg/max per metric, one row each (a template's metric keys are not known to the SQL). */
export const serviceMetricRollups = pgTable(
  "service_metric_rollups",
  {
    instanceId: uuid("instance_id")
      .notNull()
      .references(() => serviceInstances.id, { onDelete: "cascade" }),
    bucket: text("bucket").notNull(),
    ts: timestamp("ts").notNull(),
    metric: text("metric").notNull(),
    min: doublePrecision("min"),
    avg: doublePrecision("avg"),
    max: doublePrecision("max"),
    samples: integer("samples").notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ name: "service_metric_rollups_pk", columns: [t.instanceId, t.bucket, t.ts, t.metric] }),
    tsIdx: index("service_metric_rollups_ts_idx").on(t.ts),
  }),
);
