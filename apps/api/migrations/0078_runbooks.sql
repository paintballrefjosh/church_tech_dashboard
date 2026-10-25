-- A runbook (a wiki page with what to do when it fails) for a monitor and for an infrastructure host. Deleting the page
-- clears the link. Additive: older code ignores both columns.
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "runbook_page_id" uuid REFERENCES "wiki_pages"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "infra_targets" ADD COLUMN IF NOT EXISTS "runbook_page_id" uuid REFERENCES "wiki_pages"("id") ON DELETE set null;
