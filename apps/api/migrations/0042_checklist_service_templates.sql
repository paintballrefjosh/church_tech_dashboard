-- A service can now pull tasks from multiple templates instead of exactly
-- one: checklist_service_templates replaces checklist_services.template_id.
-- FKs are inline / bare ALTER (no DO-blocks) because CockroachDB v24.2
-- rejects anonymous PL/pgSQL. The backfill runs before the old column is
-- dropped so every existing service keeps its (now sole) linked template.
CREATE TABLE IF NOT EXISTS "checklist_service_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checklist_service_templates" ADD CONSTRAINT "checklist_service_templates_service_id_checklist_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "checklist_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_service_templates" ADD CONSTRAINT "checklist_service_templates_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "checklist_service_templates_service_idx" ON "checklist_service_templates" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_service_templates_uniq" ON "checklist_service_templates" USING btree ("service_id","template_id");--> statement-breakpoint
INSERT INTO "checklist_service_templates" ("service_id", "template_id", "sort_order")
SELECT "id", "template_id", 0
FROM "checklist_services"
WHERE "template_id" IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "checklist_services" DROP CONSTRAINT IF EXISTS "checklist_services_template_id_checklist_templates_id_fk";--> statement-breakpoint
ALTER TABLE "checklist_services" DROP COLUMN IF EXISTS "template_id";
