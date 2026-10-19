-- Checking stored backups: when each archive last passed a full re-read, why the last one failed, when it was tried.
-- Additive: older code ignores the columns.
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "verify_error" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "verify_tried_at" timestamp with time zone;
