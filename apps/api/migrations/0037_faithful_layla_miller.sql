ALTER TABLE "ipam_hosts" ADD COLUMN "unifi_name" text;--> statement-breakpoint
ALTER TABLE "ipam_hosts" DROP COLUMN IF EXISTS "bonjour_name";