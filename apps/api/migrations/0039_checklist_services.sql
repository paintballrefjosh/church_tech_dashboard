-- Checklist "services" (recurring definitions) + per-position defaults, and the
-- per-event assignee roster that replaces the single per-task assigned_user_id
-- for gating completion. FKs are inline / bare ALTER (no DO-blocks) because
-- CockroachDB v24.2 rejects anonymous PL/pgSQL. A backfill at the end seeds the
-- roster from existing tasks so already-created events keep working.
CREATE TABLE IF NOT EXISTS "checklist_event_assignees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"position_name" text NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklist_service_position_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_position_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklist_service_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"position_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "checklist_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"template_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"recurrence_kind" text DEFAULT 'weekly' NOT NULL,
	"weekday" integer DEFAULT 0 NOT NULL,
	"time_of_day" text DEFAULT '09:00' NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_events" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "checklist_events" ADD COLUMN "occurrence_date" timestamp;--> statement-breakpoint
ALTER TABLE "checklist_event_assignees" ADD CONSTRAINT "checklist_event_assignees_event_id_checklist_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "checklist_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_event_assignees" ADD CONSTRAINT "checklist_event_assignees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_service_position_defaults" ADD CONSTRAINT "checklist_service_position_defaults_service_position_id_checklist_service_positions_id_fk" FOREIGN KEY ("service_position_id") REFERENCES "checklist_service_positions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_service_position_defaults" ADD CONSTRAINT "checklist_service_position_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_service_positions" ADD CONSTRAINT "checklist_service_positions_service_id_checklist_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "checklist_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_services" ADD CONSTRAINT "checklist_services_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_services" ADD CONSTRAINT "checklist_services_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_events" ADD CONSTRAINT "checklist_events_service_id_checklist_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "checklist_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_event_assignees_event_idx" ON "checklist_event_assignees" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_event_assignees_user_idx" ON "checklist_event_assignees" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_event_assignees_uniq" ON "checklist_event_assignees" USING btree ("event_id","position_name","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_service_position_defaults_position_idx" ON "checklist_service_position_defaults" USING btree ("service_position_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_service_position_defaults_uniq" ON "checklist_service_position_defaults" USING btree ("service_position_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_service_positions_service_idx" ON "checklist_service_positions" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_service_positions_uniq" ON "checklist_service_positions" USING btree ("service_id","position_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_services_name_idx" ON "checklist_services" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_events_service_occurrence_uniq" ON "checklist_events" USING btree ("service_id","occurrence_date");--> statement-breakpoint
INSERT INTO "checklist_event_assignees" ("event_id", "position_name", "user_id", "source")
SELECT DISTINCT t."event_id", COALESCE(t."position_name", 'Other'), t."assigned_user_id", 'pc'
FROM "checklist_event_tasks" t
WHERE t."assigned_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;
