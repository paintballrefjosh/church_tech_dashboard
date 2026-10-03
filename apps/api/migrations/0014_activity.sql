CREATE TABLE IF NOT EXISTS "activity_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid,
  "actor_email" text,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" uuid,
  "title" text NOT NULL,
  "summary" text,
  "link" text,
  "ts" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "activity_events_ts_idx" ON "activity_events" ("ts");
CREATE INDEX IF NOT EXISTS "activity_events_resource_idx"
  ON "activity_events" ("resource_type", "resource_id");
