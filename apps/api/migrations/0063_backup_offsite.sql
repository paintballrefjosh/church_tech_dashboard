-- Offsite copies of backups: whether each schedule's backups are copied, and the state of each backup's copy.
-- Additive: older code ignores the columns.
ALTER TABLE "backup_schedules" ADD COLUMN IF NOT EXISTS "offsite" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "offsite_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "offsite_key" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "offsite_error" text;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "offsite_tried_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "offsite_dest" text;
