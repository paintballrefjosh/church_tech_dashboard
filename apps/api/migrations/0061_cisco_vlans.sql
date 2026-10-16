CREATE TABLE IF NOT EXISTS "cisco_vlans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"switch_id" uuid NOT NULL REFERENCES "public"."cisco_switches"("id") ON DELETE cascade,
	"vlan_id" integer NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "cisco_vlans_switch_vlan_uq" UNIQUE("switch_id","vlan_id")
);
--> statement-breakpoint
ALTER TABLE "cisco_switches" ADD COLUMN IF NOT EXISTS "vlan_baseline_at" timestamp;
