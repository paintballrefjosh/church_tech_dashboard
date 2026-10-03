-- Checklists module. Two-tier model:
--   * templates with master tasks (reusable across events)
--   * events: a template instantiated against a date, with tasks
--     snapshot-copied so future template edits don't retroactively change
--     past events.

CREATE TABLE IF NOT EXISTS "checklist_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "checklist_templates_name_idx" ON "checklist_templates" ("name");

CREATE TABLE IF NOT EXISTS "checklist_template_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "checklist_templates"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "position_name" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "checklist_template_tasks_template_idx"
  ON "checklist_template_tasks" ("template_id");

CREATE TABLE IF NOT EXISTS "checklist_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_id" uuid REFERENCES "checklist_templates"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "scheduled_at" timestamp,
  "pc_service_type_id" text,
  "pc_plan_id" text,
  "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "checklist_events_scheduled_idx" ON "checklist_events" ("scheduled_at");

CREATE TABLE IF NOT EXISTS "checklist_event_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "event_id" uuid NOT NULL REFERENCES "checklist_events"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "description" text,
  "position_name" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "assigned_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "note" text,
  "completed_at" timestamp,
  "completed_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "checklist_event_tasks_event_idx" ON "checklist_event_tasks" ("event_id");
CREATE INDEX IF NOT EXISTS "checklist_event_tasks_assigned_idx"
  ON "checklist_event_tasks" ("assigned_user_id");
