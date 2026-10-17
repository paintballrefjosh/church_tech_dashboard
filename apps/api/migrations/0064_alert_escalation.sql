-- Alerting: flapping monitors, acknowledged and escalated incidents, and the status page list.
-- Additive: older code ignores the columns.
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "flapping_since" timestamp;
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "show_on_status" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "status_name" text;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamp;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "acknowledged_by" uuid;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "escalation_level" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD COLUMN IF NOT EXISTS "escalated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "monitor_incidents" ADD CONSTRAINT "monitor_incidents_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
