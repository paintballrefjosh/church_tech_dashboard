import { pgTable, text, boolean, timestamp, uuid, integer, real, jsonb, bigint, index, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users";
import { locations } from "./assets";
import type { SignageManifest, SignagePiStatus } from "@lampstand/shared";

/**
 * Signage (docs/signage.md section 8). Wall-clock times are "HH:MM" text and dates DATE-ONLY text on `site.timezone`;
 * `days_of_week` is jsonb (the backup codec writes back jsonb, not integer[]). Columns written by the jobs are volatile in
 * the backup registry.
 */

/** One uploaded picture or video. The file played is the rendition (`storage_key`, named by its own sha256). */
export const signageMedia = pgTable(
  "signage_media",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    originalName: text("original_name").notNull(),
    mime: text("mime").notNull().default(""),
    kind: text("kind"),
    status: text("status").notNull().default("uploaded"),
    uploadKey: text("upload_key"),
    storageKey: text("storage_key"),
    thumbKey: text("thumb_key"),
    sha256: text("sha256"),
    width: integer("width"),
    height: integer("height"),
    durationS: real("duration_s"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    error: text("error"),
    claimedUntil: timestamp("claimed_until"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ shaIdx: index("signage_media_sha_idx").on(t.sha256), statusIdx: index("signage_media_status_idx").on(t.status) }),
);

export const signagePlaylists = pgTable("signage_playlists", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  defaultImageDurationS: real("default_image_duration_s").notNull().default(8),
  isAdhoc: boolean("is_adhoc").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const signagePlaylistItems = pgTable(
  "signage_playlist_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => signagePlaylists.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => signageMedia.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    durationS: real("duration_s"),
    enabled: boolean("enabled").notNull().default(true),
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
  },
  (t) => ({ playlistIdx: index("signage_playlist_items_playlist_idx").on(t.playlistId, t.position), mediaIdx: index("signage_playlist_items_media_idx").on(t.mediaId) }),
);

/** The logical TV. One device (Pi) drives it at a time. */
export const signageScreens = pgTable("signage_screens", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  orientation: text("orientation").notNull().default("landscape"),
  // Not used yet (v1 is 1080p everywhere); reserved for per-screen resolution (docs/signage.md section 10).
  width: integer("width").notNull().default(1920),
  height: integer("height").notNull().default(1080),
  tvControl: text("tv_control").notNull().default("none"),
  rokuIp: text("roku_ip"),
  rokuSerial: text("roku_serial"),
  hdmiInput: text("hdmi_input"),
  fallbackPlaylistId: uuid("fallback_playlist_id").references(() => signagePlaylists.id, { onDelete: "set null" }),
  notes: text("notes").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  manifestDirtyAt: timestamp("manifest_dirty_at").defaultNow(),
  manifestVersion: integer("manifest_version"),
  manifestCompiledAt: timestamp("manifest_compiled_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const signageGroups = pgTable("signage_groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const signageScreenGroups = pgTable(
  "signage_screen_groups",
  {
    screenId: uuid("screen_id")
      .notNull()
      .references(() => signageScreens.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => signageGroups.id, { onDelete: "cascade" }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.screenId, t.groupId] }), groupIdx: index("signage_screen_groups_group_idx").on(t.groupId) }),
);

/**
 * A schedule entry: one-time (`starts_at`-`ends_at`), weekly or monthly (`month_weeks`). `target_id` is a screen or a screen
 * group (no foreign key: two tables; deleting either removes its entries), or null for all screens. `kind` is null only on
 * rows from before migration 0093 (weekly, with the old 0-999 priority), which the `signage-schedule-adopt` job converts,
 * together with the old `signage_overrides` (events).
 */
export const signageSchedules = pgTable("signage_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  kind: text("kind"),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  playlistId: uuid("playlist_id")
    .notNull()
    .references(() => signagePlaylists.id, { onDelete: "cascade" }),
  /** 1 (lowest) to 5 (highest). */
  priority: integer("priority").notNull().default(100),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull(),
  monthWeeks: jsonb("month_weeks").$type<number[]>(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  forcePowerOn: boolean("force_power_on").notNull().default(false),
  startDate: text("start_date"),
  endDate: text("end_date"),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/** One-off events from before migration 0093. Read only by the `signage-schedule-adopt` job, which moves them into `signage_schedules`; dropped in a later release. */
export const signageOverrides = pgTable(
  "signage_overrides",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    playlistId: uuid("playlist_id")
      .notNull()
      .references(() => signagePlaylists.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    priority: integer("priority").notNull().default(1000),
    forcePowerOn: boolean("force_power_on").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ endsIdx: index("signage_overrides_ends_idx").on(t.endsAt) }),
);

export const signagePowerSchedules = pgTable("signage_power_schedules", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  daysOfWeek: jsonb("days_of_week").$type<number[]>().notNull(),
  onTime: text("on_time").notNull(),
  offTime: text("off_time").notNull(),
  startDate: text("start_date"),
  endDate: text("end_date"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** The last few compiled manifests per screen (rebuilt from the rows above at any time). */
export const signageManifests = pgTable(
  "signage_manifests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    screenId: uuid("screen_id")
      .notNull()
      .references(() => signageScreens.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    sha256: text("sha256").notNull(),
    body: jsonb("body").$type<SignageManifest>().notNull(),
    warnings: jsonb("warnings").$type<string[]>().notNull().default([]),
    builtAt: timestamp("built_at").notNull().defaultNow(),
  },
  (t) => ({ screenVersionIdx: uniqueIndex("signage_manifests_screen_version_idx").on(t.screenId, t.version) }),
);

/** A Raspberry Pi the dashboard set up (or is setting up). Reached over SSH only. */
export const signageDevices = pgTable(
  "signage_devices",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    screenId: uuid("screen_id").references(() => signageScreens.id, { onDelete: "set null" }),
    ip: text("ip").notNull(),
    sshPort: integer("ssh_port").notNull().default(22),
    knownHostKey: text("known_host_key"),
    hostKeyMismatch: boolean("host_key_mismatch").notNull().default(false),
    loginUser: text("login_user"),
    /** The Imager account setup logged in with (locked afterwards when the settings say so). */
    setupUser: text("setup_user"),
    keyGeneration: integer("key_generation"),
    serial: text("serial"),
    model: text("model"),
    osRelease: text("os_release"),
    macWlan: text("mac_wlan"),
    macEth: text("mac_eth"),
    agentVersion: text("agent_version"),
    appliedSettingsHash: text("applied_settings_hash"),
    /** The dashboard addresses this Pi has seen logins from (SSH_CONNECTION), for "only the dashboard may connect". */
    dashboardSources: jsonb("dashboard_sources").$type<string[]>().notNull().default([]),
    manifestVersionApplied: integer("manifest_version_applied"),
    manifestWantedSince: timestamp("manifest_wanted_since"),
    status: text("status").notNull().default("setting_up"),
    enabled: boolean("enabled").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at"),
    lastError: text("last_error"),
    latest: jsonb("latest").$type<SignagePiStatus>(),
    identifyCode: text("identify_code"),
    identifyUntil: timestamp("identify_until"),
    offlineAlerted: boolean("offline_alerted").notNull().default(false),
    claimedUntil: timestamp("claimed_until"),
    syncClaimedUntil: timestamp("sync_claimed_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ screenIdx: uniqueIndex("signage_devices_screen_idx").on(t.screenId), hostKeyIdx: index("signage_devices_host_key_idx").on(t.knownHostKey) }),
);

export const signageDiscoverySubnets = pgTable("signage_discovery_subnets", {
  id: uuid("id").defaultRandom().primaryKey(),
  cidr: text("cidr").notNull().unique(),
  label: text("label").notNull().default(""),
  continuous: boolean("continuous").notNull().default(false),
  intervalMin: integer("interval_min").notNull().default(60),
  lastRunAt: timestamp("last_run_at"),
  lastFound: integer("last_found"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/** SSH hosts discovery found that are not set up (yet). */
export const signageFound = pgTable("signage_found", {
  id: uuid("id").defaultRandom().primaryKey(),
  ip: text("ip").notNull().unique(),
  hostKey: text("host_key"),
  banner: text("banner"),
  evidence: text("evidence").notNull(),
  evidenceText: text("evidence_text").notNull().default(""),
  mac: text("mac"),
  name: text("name"),
  /** Found by continuous discovery and not looked at yet. */
  isNew: boolean("is_new").notNull().default(false),
  firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  dismissedAt: timestamp("dismissed_at"),
  notifiedAt: timestamp("notified_at"),
});

/** A setup, "apply again", update or "show a code" run: its live log, kept 90 days. */
export const signageSetupRuns = pgTable(
  "signage_setup_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id").references(() => signageDevices.id, { onDelete: "set null" }),
    ip: text("ip").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    step: text("step"),
    output: text("output").notNull().default(""),
    error: text("error"),
    /** Non-secret parameters (found id, name, screen). */
    request: jsonb("request").$type<Record<string, unknown>>().notNull().default({}),
    /** A login typed for this run only, encrypted; cleared when the run ends. */
    secretEnc: text("secret_enc"),
    startedBy: uuid("started_by").references(() => users.id, { onDelete: "set null" }),
    claimedUntil: timestamp("claimed_until"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => ({ deviceIdx: index("signage_setup_runs_device_idx").on(t.deviceId, t.createdAt), statusIdx: index("signage_setup_runs_status_idx").on(t.status) }),
);

export const signageStatusSamples = pgTable(
  "signage_status_samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    deviceId: uuid("device_id")
      .notNull()
      .references(() => signageDevices.id, { onDelete: "cascade" }),
    ts: timestamp("ts").notNull().defaultNow(),
    cpuTempC: real("cpu_temp_c"),
    cpuPct: real("cpu_pct"),
    wifiRssiDbm: real("wifi_rssi_dbm"),
    diskFreeMb: real("disk_free_mb"),
    memFreeMb: real("mem_free_mb"),
  },
  (t) => ({ deviceTsIdx: index("signage_status_samples_device_ts_idx").on(t.deviceId, t.ts) }),
);

export const signageScreenshots = pgTable("signage_screenshots", {
  deviceId: uuid("device_id")
    .primaryKey()
    .references(() => signageDevices.id, { onDelete: "cascade" }),
  jpegB64: text("jpeg_b64").notNull(),
  takenAt: timestamp("taken_at").notNull().defaultNow(),
});

export const signageAgentReleases = pgTable("signage_agent_releases", {
  id: uuid("id").defaultRandom().primaryKey(),
  version: text("version").notNull().unique(),
  sha256: text("sha256").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  /** null = the release bundled in the API image (read from its file). */
  storageKey: text("storage_key"),
  notes: text("notes").notNull().default(""),
  isCurrent: boolean("is_current").notNull().default(false),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
