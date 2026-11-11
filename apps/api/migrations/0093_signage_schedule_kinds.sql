ALTER TABLE "signage_schedules" ADD COLUMN IF NOT EXISTS "kind" text;--> statement-breakpoint
ALTER TABLE "signage_schedules" ADD COLUMN IF NOT EXISTS "starts_at" timestamp;--> statement-breakpoint
ALTER TABLE "signage_schedules" ADD COLUMN IF NOT EXISTS "ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "signage_schedules" ADD COLUMN IF NOT EXISTS "month_weeks" jsonb;--> statement-breakpoint
ALTER TABLE "signage_schedules" ADD COLUMN IF NOT EXISTS "force_power_on" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "signage_schedules" ALTER COLUMN "target_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "signage_schedules" ALTER COLUMN "start_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "signage_schedules" ALTER COLUMN "end_time" DROP NOT NULL;
