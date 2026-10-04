-- Infrastructure monitoring: targets, credentials, metrics time-series, rollups,
-- discovered entities; plus polymorphic monitor_incidents (monitor OR infra target).
-- NOTE: written CockroachDB-friendly (no `DO $$ ... EXCEPTION` blocks, which
-- Cockroach v24.2 rejects). Fresh tables use inline REFERENCES; the incidents FK
-- is a plain ADD CONSTRAINT (the column/constraint don't pre-exist).
CREATE TABLE IF NOT EXISTS "infra_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"host" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"interval_sec" integer DEFAULT 30 NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"known_host_key" text,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_polled_at" timestamp,
	"last_error" text,
	"last_sample" jsonb,
	"alert_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "infra_target_credentials" (
	"target_id" uuid PRIMARY KEY NOT NULL REFERENCES "infra_targets"("id") ON DELETE cascade,
	"auth_type" text NOT NULL,
	"username" text,
	"secret_enc" text,
	"extra_enc" text,
	"ca_cert" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "infra_metric_samples" (
	"target_id" uuid NOT NULL REFERENCES "infra_targets"("id") ON DELETE cascade,
	"entity_kind" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"ts" timestamp DEFAULT now() NOT NULL,
	"cpu_pct" real,
	"mem_pct" real,
	"disk_pct_max" real,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "infra_metric_samples_target_id_entity_kind_entity_id_ts_pk" PRIMARY KEY("target_id","entity_kind","entity_id","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "infra_metric_rollups" (
	"target_id" uuid NOT NULL REFERENCES "infra_targets"("id") ON DELETE cascade,
	"entity_kind" text NOT NULL,
	"entity_id" text DEFAULT '' NOT NULL,
	"bucket" text NOT NULL,
	"ts" timestamp NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "infra_metric_rollups_target_id_entity_kind_entity_id_bucket_ts_pk" PRIMARY KEY("target_id","entity_kind","entity_id","bucket","ts")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "infra_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL REFERENCES "infra_targets"("id") ON DELETE cascade,
	"entity_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"group_key" text,
	"status" text NOT NULL,
	"health" text,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "infra_targets_enabled_idx" ON "infra_targets" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "infra_metric_samples_ts_idx" ON "infra_metric_samples" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "infra_metric_rollups_ts_idx" ON "infra_metric_rollups" USING btree ("ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "infra_entities_target_idx" ON "infra_entities" USING btree ("target_id","entity_kind");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "infra_entities_external_unique" ON "infra_entities" USING btree ("target_id","entity_kind","external_id");--> statement-breakpoint
ALTER TABLE "monitor_incidents" ALTER COLUMN "monitor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "target_id" uuid;--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "rule_id" text;--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "detail" jsonb;--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_target_id_infra_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "infra_targets"("id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "monitor_incidents_target_open_idx" ON "monitor_incidents" USING btree ("target_id","resolved_at");
-- Retention for the metrics stores (raw samples 7 days; rollups 90 days for
-- 5m buckets, 365 days for 1h buckets) is enforced by the API's pruner
-- (InfraCollector.prune), not by the database. This migration originally set
-- CockroachDB row-level TTL here, which YugabyteDB/Postgres reject; databases
-- that already ran the original keep that TTL, which is harmless alongside the
-- pruner.
