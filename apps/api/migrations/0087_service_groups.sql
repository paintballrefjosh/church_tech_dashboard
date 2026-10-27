-- Service groups (docs/service-monitoring.md section 0): services on different hosts judged together (a quorum, a role
-- count such as "exactly one MASTER"). A group's own incidents are monitor_incidents with service_group_id set; the
-- unique index on (service_group_id, group_open_rule) makes "one open incident per group and rule" the database's rule, so
-- two nodes can never open two: group_open_rule is the rule id while the incident is open and NULL once it is resolved (NULLs
-- never collide). Not a partial index: CockroachDB cannot build one on a column added in the same transaction.
CREATE TABLE IF NOT EXISTS "service_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"min_healthy" integer,
	"role_rule" jsonb,
	"for_sec" integer DEFAULT 60 NOT NULL,
	"alerts" boolean DEFAULT true NOT NULL,
	"created_by" uuid REFERENCES "users"("id") ON DELETE set null,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"last_evaluated_at" timestamp,
	"last_result" jsonb,
	"alert_state" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "service_groups_name_idx" ON "service_groups" USING btree ("name");
--> statement-breakpoint
ALTER TABLE "service_instances" ADD COLUMN IF NOT EXISTS "group_id" uuid REFERENCES "service_groups"("id") ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "service_instances_group_idx" ON "service_instances" USING btree ("group_id");
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "service_group_id" uuid REFERENCES "service_groups"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "group_open_rule" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitor_incidents_group_open_idx" ON "monitor_incidents" USING btree ("service_group_id", "group_open_rule");
