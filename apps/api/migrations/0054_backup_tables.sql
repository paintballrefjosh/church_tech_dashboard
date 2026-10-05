CREATE TABLE IF NOT EXISTS "backup_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"frequency" text NOT NULL,
	"time_of_day" text NOT NULL,
	"day_of_week" integer DEFAULT 0 NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"timezone" text NOT NULL,
	"keep_count" integer DEFAULT 7 NOT NULL,
	"include_files" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"next_run_at" timestamp with time zone,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"schedule_id" uuid REFERENCES "backup_schedules"("id") ON DELETE set null,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"s3_key" text NOT NULL,
	"size_bytes" bigint,
	"sha256" text,
	"include_files" boolean DEFAULT true NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"file_bytes" bigint DEFAULT 0 NOT NULL,
	"table_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"schema_migrations" integer,
	"app_version" text,
	"secret_fingerprint" text,
	"error" text,
	"node_id" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"backup_id" uuid REFERENCES "backups"("id") ON DELETE set null,
	"requested_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"phase" text DEFAULT '' NOT NULL,
	"progress" jsonb,
	"options" jsonb,
	"result" jsonb,
	"error" text,
	"node_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backup_operations_started_idx" ON "backup_operations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backups_created_idx" ON "backups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backups_schedule_idx" ON "backups" USING btree ("schedule_id");
