-- Signage (docs/signage.md): TV screens driven by Raspberry Pis that the dashboard discovers and sets up over SSH. Additive:
-- older code ignores the new tables. Grants Signage to no existing group: a new non-system group `signage` gets Signage
-- moderator, created only when no group of that name exists (an install's own group of that name is left untouched).
CREATE TABLE IF NOT EXISTS "signage_media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text DEFAULT '' NOT NULL,
	"kind" text,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"upload_key" text,
	"storage_key" text,
	"thumb_key" text,
	"sha256" text,
	"width" integer,
	"height" integer,
	"duration_s" real,
	"size_bytes" bigint,
	"error" text,
	"claimed_until" timestamp,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_media_sha_idx" ON "signage_media" USING btree ("sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_media_status_idx" ON "signage_media" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_playlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"default_image_duration_s" real DEFAULT 8 NOT NULL,
	"is_adhoc" boolean DEFAULT false NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_playlist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"playlist_id" uuid NOT NULL REFERENCES "signage_playlists"("id") ON DELETE cascade,
	"media_id" uuid NOT NULL REFERENCES "signage_media"("id") ON DELETE cascade,
	"position" integer NOT NULL,
	"duration_s" real,
	"enabled" boolean DEFAULT true NOT NULL,
	"valid_from" text,
	"valid_until" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_playlist_items_playlist_idx" ON "signage_playlist_items" USING btree ("playlist_id","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_playlist_items_media_idx" ON "signage_playlist_items" USING btree ("media_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_screens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location_id" uuid REFERENCES "locations"("id") ON DELETE set null,
	"orientation" text DEFAULT 'landscape' NOT NULL,
	"width" integer DEFAULT 1920 NOT NULL,
	"height" integer DEFAULT 1080 NOT NULL,
	"tv_control" text DEFAULT 'none' NOT NULL,
	"roku_ip" text,
	"roku_serial" text,
	"hdmi_input" text,
	"fallback_playlist_id" uuid REFERENCES "signage_playlists"("id") ON DELETE set null,
	"notes" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"manifest_dirty_at" timestamp DEFAULT now(),
	"manifest_version" integer,
	"manifest_compiled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_screen_groups" (
	"screen_id" uuid NOT NULL REFERENCES "signage_screens"("id") ON DELETE cascade,
	"group_id" uuid NOT NULL REFERENCES "signage_groups"("id") ON DELETE cascade,
	PRIMARY KEY ("screen_id", "group_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_screen_groups_group_idx" ON "signage_screen_groups" USING btree ("group_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"playlist_id" uuid NOT NULL REFERENCES "signage_playlists"("id") ON DELETE cascade,
	"priority" integer DEFAULT 100 NOT NULL,
	"days_of_week" jsonb NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"playlist_id" uuid NOT NULL REFERENCES "signage_playlists"("id") ON DELETE cascade,
	"starts_at" timestamp NOT NULL,
	"ends_at" timestamp NOT NULL,
	"priority" integer DEFAULT 1000 NOT NULL,
	"force_power_on" boolean DEFAULT false NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_overrides_ends_idx" ON "signage_overrides" USING btree ("ends_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_power_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"days_of_week" jsonb NOT NULL,
	"on_time" text NOT NULL,
	"off_time" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"screen_id" uuid NOT NULL REFERENCES "signage_screens"("id") ON DELETE cascade,
	"version" integer NOT NULL,
	"sha256" text NOT NULL,
	"body" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"built_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signage_manifests_screen_version_idx" ON "signage_manifests" USING btree ("screen_id","version");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"screen_id" uuid REFERENCES "signage_screens"("id") ON DELETE set null,
	"ip" text NOT NULL,
	"ssh_port" integer DEFAULT 22 NOT NULL,
	"known_host_key" text,
	"host_key_mismatch" boolean DEFAULT false NOT NULL,
	"login_user" text,
	"key_generation" integer,
	"serial" text,
	"model" text,
	"os_release" text,
	"mac_wlan" text,
	"mac_eth" text,
	"agent_version" text,
	"applied_settings_hash" text,
	"dashboard_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest_version_applied" integer,
	"manifest_wanted_since" timestamp,
	"status" text DEFAULT 'setting_up' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp,
	"last_error" text,
	"latest" jsonb,
	"identify_code" text,
	"identify_until" timestamp,
	"offline_alerted" boolean DEFAULT false NOT NULL,
	"claimed_until" timestamp,
	"sync_claimed_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signage_devices_screen_idx" ON "signage_devices" USING btree ("screen_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_devices_host_key_idx" ON "signage_devices" USING btree ("known_host_key");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_discovery_subnets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cidr" text NOT NULL UNIQUE,
	"label" text DEFAULT '' NOT NULL,
	"continuous" boolean DEFAULT false NOT NULL,
	"interval_min" integer DEFAULT 60 NOT NULL,
	"last_run_at" timestamp,
	"last_found" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_found" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL UNIQUE,
	"host_key" text,
	"banner" text,
	"evidence" text NOT NULL,
	"evidence_text" text DEFAULT '' NOT NULL,
	"mac" text,
	"name" text,
	"is_new" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"dismissed_at" timestamp,
	"notified_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_setup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid REFERENCES "signage_devices"("id") ON DELETE set null,
	"ip" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"step" text,
	"output" text DEFAULT '' NOT NULL,
	"error" text,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"started_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"claimed_until" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_setup_runs_device_idx" ON "signage_setup_runs" USING btree ("device_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_setup_runs_status_idx" ON "signage_setup_runs" USING btree ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_status_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL REFERENCES "signage_devices"("id") ON DELETE cascade,
	"ts" timestamp DEFAULT now() NOT NULL,
	"cpu_temp_c" real,
	"wifi_rssi_dbm" real,
	"disk_free_mb" real,
	"mem_free_mb" real
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signage_status_samples_device_ts_idx" ON "signage_status_samples" USING btree ("device_id","ts");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_screenshots" (
	"device_id" uuid PRIMARY KEY NOT NULL REFERENCES "signage_devices"("id") ON DELETE cascade,
	"jpeg_b64" text NOT NULL,
	"taken_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signage_agent_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL UNIQUE,
	"sha256" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text,
	"notes" text DEFAULT '' NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The `signage` group for installs seeded before the module existed (the seed creates it on fresh installs).
INSERT INTO groups (name, description, is_managed, is_system)
SELECT 'signage', 'Runs the TV screens: media, playlists, schedules, events and power times. Add the people who look after the TVs.', false, false
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'signage');
--> statement-breakpoint
-- Only a `signage` group with no module access at all (the one just made, never an install's own) gets Signage moderator.
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT g.id, 'signage', 'moderator' FROM groups g
WHERE g.name = 'signage' AND g.is_system = false AND NOT EXISTS (SELECT 1 FROM group_module_access a WHERE a.group_id = g.id)
ON CONFLICT (group_id, module_key) DO NOTHING;
