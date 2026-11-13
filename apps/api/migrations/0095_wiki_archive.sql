-- Wiki: archiving a page. An archived page is left out of the wiki menu and sorts last in searches, but is still readable by
-- address. Additive: older code ignores the columns.
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "archived_at" timestamp;
--> statement-breakpoint
ALTER TABLE "wiki_pages" ADD COLUMN IF NOT EXISTS "archived_by" uuid REFERENCES "users"("id") ON DELETE set null;
