-- Service monitoring templates (docs/service-monitoring.md): custom templates (built-ins live in code), shared logins, the
-- instances attached to infra hosts, and their readings. Additive: older code ignores the new tables.
CREATE TABLE IF NOT EXISTS "service_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"forked_from" text,
	"body" jsonb NOT NULL,
	"runs_commands" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"updated_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_logins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_enc" text,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_logins_name_idx" ON "service_logins" USING btree ("name");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL REFERENCES "infra_targets"("id") ON DELETE cascade,
	"template_key" text NOT NULL,
	"name" text NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"interval_sec" integer DEFAULT 60 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_polled_at" timestamp,
	"claimed_until" timestamp,
	"last_values" jsonb,
	"last_states" jsonb,
	"members" jsonb,
	"members_omitted" integer DEFAULT 0 NOT NULL,
	"checks" jsonb,
	"collector_errors" jsonb,
	"counters" jsonb,
	"alert_state" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_instances_target_idx" ON "service_instances" USING btree ("target_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_metric_samples" (
	"instance_id" uuid NOT NULL REFERENCES "service_instances"("id") ON DELETE cascade,
	"ts" timestamp DEFAULT now() NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "service_metric_samples_pk" PRIMARY KEY("instance_id","ts")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_metric_samples_ts_idx" ON "service_metric_samples" USING btree ("ts");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "service_metric_rollups" (
	"instance_id" uuid NOT NULL REFERENCES "service_instances"("id") ON DELETE cascade,
	"bucket" text NOT NULL,
	"ts" timestamp NOT NULL,
	"metric" text NOT NULL,
	"min" double precision,
	"avg" double precision,
	"max" double precision,
	"samples" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "service_metric_rollups_pk" PRIMARY KEY("instance_id","bucket","ts","metric")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_metric_rollups_ts_idx" ON "service_metric_rollups" USING btree ("ts");
