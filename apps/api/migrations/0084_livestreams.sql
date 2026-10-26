-- Livestream checks (docs/livestreams.md): the streams, their latest still picture and their history. Additive: older code
-- ignores the new tables. Grants by the tiers a group already holds, never by a group's name (the groups may be renamed).
CREATE TABLE IF NOT EXISTS "livestreams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"platform" text NOT NULL,
	"access" text DEFAULT 'public' NOT NULL,
	"page_url" text DEFAULT '' NOT NULL,
	"stream_url_enc" text,
	"platform_ref" text DEFAULT '' NOT NULL,
	"status_interval_sec" integer DEFAULT 60 NOT NULL,
	"sample_interval_sec" integer DEFAULT 300 NOT NULL,
	"sample_seconds" integer DEFAULT 10 NOT NULL,
	"schedule" text DEFAULT '' NOT NULL,
	"grace_min" integer DEFAULT 5 NOT NULL,
	"silence_db" integer DEFAULT -50 NOT NULL,
	"check_video" boolean DEFAULT true NOT NULL,
	"alert_group_id" uuid REFERENCES "groups"("id") ON DELETE set null,
	"encoder_monitor_id" uuid REFERENCES "monitors"("id") ON DELETE set null,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status_checked_at" timestamp,
	"sampled_at" timestamp,
	"next_sample_at" timestamp,
	"claimed_until" timestamp,
	"state" text DEFAULT 'unknown' NOT NULL,
	"live" boolean,
	"viewers" integer,
	"live_title" text,
	"live_started_at" timestamp,
	"source" text,
	"platform_status" text,
	"last_error" text,
	"last_sample" jsonb,
	"sample_problems" jsonb,
	"prev_sample_problems" jsonb,
	"offline_streak" integer DEFAULT 0 NOT NULL,
	"unreachable_streak" integer DEFAULT 0 NOT NULL,
	"problems" jsonb,
	"problem_since" timestamp,
	"alerted_problem" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livestream_snapshots" (
	"livestream_id" uuid PRIMARY KEY NOT NULL REFERENCES "livestreams"("id") ON DELETE cascade,
	"jpeg_b64" text NOT NULL,
	"taken_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "livestream_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"livestream_id" uuid NOT NULL REFERENCES "livestreams"("id") ON DELETE cascade,
	"ts" timestamp DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"live" boolean,
	"viewers" integer,
	"loudness_lufs" real,
	"peak_db" real,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "livestream_checks_stream_ts_idx" ON "livestream_checks" USING btree ("livestream_id","ts");
--> statement-breakpoint
-- The defaults for installs seeded before the module existed: the `user` group (a system group, its name is fixed) sees the
-- streams; any other group that moderates Monitoring or Checklists (the people who run a Sunday) manages them, and any other
-- group with Monitoring sees them. Nothing changes a grant an admin already set; the admin group is special-cased in code.
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT id, 'livestreams', 'user' FROM groups WHERE name = 'user' AND is_system = true
ON CONFLICT (group_id, module_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT DISTINCT g.id, 'livestreams', 'moderator' FROM groups g JOIN group_module_access a ON a.group_id = g.id
WHERE g.is_system = false AND a.module_key IN ('monitoring', 'checklists') AND a.tier IN ('moderator', 'admin')
ON CONFLICT (group_id, module_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT DISTINCT g.id, 'livestreams', 'user' FROM groups g JOIN group_module_access a ON a.group_id = g.id
WHERE g.is_system = false AND a.module_key = 'monitoring'
ON CONFLICT (group_id, module_key) DO NOTHING;
