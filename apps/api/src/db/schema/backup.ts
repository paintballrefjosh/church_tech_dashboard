import { pgTable, text, timestamp, uuid, bigint, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Backups of the app's own data (admin > Backups, apps/api/src/backup/). None of these
 * three tables is part of a backup or touched by a restore: the list of backups must
 * survive restoring one of them.
 */

/** Schedules for automatic backups. `next_run_at` is computed by the app (the schedule's own time zone). */
export const backupSchedules = pgTable("backup_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  /** `daily` | `weekly` | `monthly` */
  frequency: text("frequency").notNull(),
  /** Local time of day, `HH:MM`, in `timezone`. */
  timeOfDay: text("time_of_day").notNull(),
  dayOfWeek: integer("day_of_week").notNull().default(0),
  dayOfMonth: integer("day_of_month").notNull().default(1),
  timezone: text("timezone").notNull(),
  keepCount: integer("keep_count").notNull().default(7),
  includeFiles: boolean("include_files").notNull().default(true),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  /** `ok` | `failed` */
  lastStatus: text("last_status"),
  lastError: text("last_error"),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per backup archive. The archive itself is an object in the object store (`s3_key`). */
export const backups = pgTable(
  "backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    /** `manual` | `scheduled` | `pre_restore` | `uploaded` */
    kind: text("kind").notNull(),
    /** `running` | `ready` | `failed` */
    status: text("status").notNull().default("running"),
    scheduleId: uuid("schedule_id").references(() => backupSchedules.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    s3Key: text("s3_key").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    includeFiles: boolean("include_files").notNull().default(true),
    fileCount: integer("file_count").notNull().default(0),
    fileBytes: bigint("file_bytes", { mode: "number" }).notNull().default(0),
    /** `{ table: rows }` */
    tableCounts: jsonb("table_counts").notNull().default({}),
    schemaMigrations: integer("schema_migrations"),
    appVersion: text("app_version"),
    /** Fingerprint of the AUTH_SECRET the backup was made under (encrypted settings need the same one). */
    secretFingerprint: text("secret_fingerprint"),
    error: text("error"),
    nodeId: text("node_id"),
  },
  (t) => ({
    createdIdx: index("backups_created_idx").on(t.createdAt),
    scheduleIdx: index("backups_schedule_idx").on(t.scheduleId),
  }),
);

/**
 * Progress and outcome of a long-running action (a backup, an import, a comparison, a
 * restore), so any node can answer "how is it going?" while another does the work.
 * A running row whose `updated_at` stops moving belongs to a node that died.
 */
export const backupOperations = pgTable(
  "backup_operations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** `backup` | `import` | `compare` | `restore` */
    kind: text("kind").notNull(),
    /** `running` | `succeeded` | `failed` */
    status: text("status").notNull().default("running"),
    backupId: uuid("backup_id").references(() => backups.id, { onDelete: "set null" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    phase: text("phase").notNull().default(""),
    progress: jsonb("progress"),
    options: jsonb("options"),
    /** A comparison's report or a restore's summary. */
    result: jsonb("result"),
    error: text("error"),
    nodeId: text("node_id"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => ({
    startedIdx: index("backup_operations_started_idx").on(t.startedAt),
  }),
);
