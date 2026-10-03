-- Phase 3 — tags. Polymorphic join table so a single Tag can be attached to
-- tickets, notes, and wiki pages without per-resource columns.

CREATE TABLE IF NOT EXISTS "tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "color" text NOT NULL DEFAULT 'slate',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "tags_name_idx" ON "tags" ("name");

CREATE TABLE IF NOT EXISTS "tag_assignments" (
  "tag_id" uuid NOT NULL REFERENCES "tags"("id") ON DELETE CASCADE,
  "resource_type" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("tag_id", "resource_type", "resource_id")
);
CREATE INDEX IF NOT EXISTS "tag_assignments_resource_idx"
  ON "tag_assignments" ("resource_type", "resource_id");
