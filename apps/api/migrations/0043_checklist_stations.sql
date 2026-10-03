-- First-class stations, assigned to a template (not per task). DDL only — the
-- backfill lives in 0044 because CockroachDB can't reference a column added
-- earlier in the same transaction. FK is a bare ALTER (no DO-block) for v24.2.
CREATE TABLE IF NOT EXISTS "checklist_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"pc_alias" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_event_tasks" ADD COLUMN "template_name" text;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "station_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_stations_name_uniq" ON "checklist_stations" USING btree ("name");--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_station_id_checklist_stations_id_fk" FOREIGN KEY ("station_id") REFERENCES "checklist_stations"("id") ON DELETE set null ON UPDATE no action;
