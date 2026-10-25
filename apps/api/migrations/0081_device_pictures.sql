-- Picture choices for infrastructure hosts and UniFi devices (the device profiles, `switch_models`), as Cisco switches
-- have had since 0071. A host stores its profile on its row; a UniFi device is not a row here, so its choice is kept by
-- MAC. Deleting a profile clears the choice. Additive: older code ignores both.
CREATE TABLE IF NOT EXISTS "unifi_device_views" (
	"mac" text PRIMARY KEY NOT NULL,
	"switch_model_id" uuid REFERENCES "switch_models"("id") ON DELETE set null,
	"switch_view_off" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "infra_targets" ADD COLUMN IF NOT EXISTS "switch_model_id" uuid REFERENCES "switch_models"("id") ON DELETE set null;
