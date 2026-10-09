ALTER TABLE "monitor_checks" ADD COLUMN IF NOT EXISTS "node_id" text;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "last_checked_by" text;
