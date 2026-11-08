ALTER TABLE "backups" ADD COLUMN IF NOT EXISTS "include_signage_media" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_schedules" ADD COLUMN IF NOT EXISTS "include_signage_media" boolean DEFAULT false NOT NULL;
