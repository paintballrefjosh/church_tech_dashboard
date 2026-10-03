-- Phase 1.3+ — admin-curated category catalogue for tickets.
-- Many-to-many: each ticket can carry multiple categories. Distinct from the
-- free-form tags table (which is shared across resources); category creation
-- is gated on the tickets:categories:write permission.

CREATE TABLE IF NOT EXISTS "ticket_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "color" text NOT NULL DEFAULT 'slate',
  "created_at" timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ticket_categories_name_idx" ON "ticket_categories" ("name");

CREATE TABLE IF NOT EXISTS "ticket_category_assignments" (
  "ticket_id" uuid NOT NULL REFERENCES "tickets"("id") ON DELETE CASCADE,
  "category_id" uuid NOT NULL REFERENCES "ticket_categories"("id") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("ticket_id", "category_id")
);
CREATE INDEX IF NOT EXISTS "ticket_category_assignments_ticket_idx"
  ON "ticket_category_assignments" ("ticket_id");
