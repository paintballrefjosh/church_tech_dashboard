import { pgTable, text, boolean, timestamp, uuid, integer, real, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { groups } from "./groups";
import { monitors } from "./monitors";

/**
 * Livestreams (docs/livestreams.md). The first block is what a person sets; the second is written by the `livestream-checks`
 * job (volatile in the backup registry: a restored reading would be stale at once). `stream_url_enc` is the private link,
 * encrypted like other secrets and never returned. `alerted_problem` is the marker of the last alert sent (`alertMarker`);
 * the job claims a notice with a conditional UPDATE on it.
 */
export const livestreams = pgTable("livestreams", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  platform: text("platform").notNull(),
  access: text("access").notNull().default("public"),
  pageUrl: text("page_url").notNull().default(""),
  streamUrlEnc: text("stream_url_enc"),
  platformRef: text("platform_ref").notNull().default(""),
  statusIntervalSec: integer("status_interval_sec").notNull().default(60),
  sampleIntervalSec: integer("sample_interval_sec").notNull().default(300),
  sampleSeconds: integer("sample_seconds").notNull().default(10),
  schedule: text("schedule").notNull().default(""),
  graceMin: integer("grace_min").notNull().default(5),
  silenceDb: integer("silence_db").notNull().default(-50),
  checkVideo: boolean("check_video").notNull().default(true),
  alertGroupId: uuid("alert_group_id").references(() => groups.id, { onDelete: "set null" }),
  encoderMonitorId: uuid("encoder_monitor_id").references(() => monitors.id, { onDelete: "set null" }),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),

  statusCheckedAt: timestamp("status_checked_at"),
  sampledAt: timestamp("sampled_at"),
  nextSampleAt: timestamp("next_sample_at"),
  claimedUntil: timestamp("claimed_until"),
  state: text("state").notNull().default("unknown"),
  live: boolean("live"),
  viewers: integer("viewers"),
  liveTitle: text("live_title"),
  liveStartedAt: timestamp("live_started_at"),
  source: text("source"),
  // What the platform's own API said about the encoder (Resi), shown on the page; informative, never a problem by itself.
  platformStatus: text("platform_status"),
  lastError: text("last_error"),
  lastSample: jsonb("last_sample"),
  sampleProblems: jsonb("sample_problems").$type<string[]>(),
  prevSampleProblems: jsonb("prev_sample_problems").$type<string[]>(),
  offlineStreak: integer("offline_streak").notNull().default(0),
  unreachableStreak: integer("unreachable_streak").notNull().default(0),
  problems: jsonb("problems").$type<string[]>(),
  problemSince: timestamp("problem_since"),
  alertedProblem: text("alerted_problem").notNull().default(""),
});

/** The latest still picture of each stream (one row per stream, replaced on each sample; a JPEG of about 15 KB). */
export const livestreamSnapshots = pgTable("livestream_snapshots", {
  livestreamId: uuid("livestream_id")
    .primaryKey()
    .references(() => livestreams.id, { onDelete: "cascade" }),
  jpegB64: text("jpeg_b64").notNull(),
  takenAt: timestamp("taken_at").notNull().defaultNow(),
});

/** History for the stream's page: one row per status check that changed something and per sample. Pruned after 30 days. */
export const livestreamChecks = pgTable(
  "livestream_checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    livestreamId: uuid("livestream_id")
      .notNull()
      .references(() => livestreams.id, { onDelete: "cascade" }),
    ts: timestamp("ts").notNull().defaultNow(),
    kind: text("kind").notNull(),
    live: boolean("live"),
    viewers: integer("viewers"),
    loudnessLufs: real("loudness_lufs"),
    peakDb: real("peak_db"),
    problems: jsonb("problems").$type<string[]>().notNull().default([]),
    error: text("error"),
  },
  (t) => ({ streamTsIdx: index("livestream_checks_stream_ts_idx").on(t.livestreamId, t.ts) }),
);
