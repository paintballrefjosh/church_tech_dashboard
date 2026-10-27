-- Service groups, part two (docs/service-monitoring.md section 0): a group may be listed on the status page under its own
-- name, and may warn when a member has not been working for redundancy_after_min minutes while the quorum still holds.
ALTER TABLE "service_groups" ADD COLUMN IF NOT EXISTS "show_on_status" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_groups" ADD COLUMN IF NOT EXISTS "status_name" text;
--> statement-breakpoint
ALTER TABLE "service_groups" ADD COLUMN IF NOT EXISTS "redundancy_after_min" integer;
