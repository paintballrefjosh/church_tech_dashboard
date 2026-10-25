-- Rooms (`locations`) and the asset inventory with check-outs (docs/assets.md), and a room/asset link on the things that sit
-- in rooms. Additive: older code ignores the new tables and columns. The cabinets' free-text location is turned into rooms by
-- the API at start (LocationsService.adoptRackLocations), not here: CockroachDB cannot write a column added in the same
-- transaction.
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"building" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "locations_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag" text NOT NULL,
	"name" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"make" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"serial" text DEFAULT '' NOT NULL,
	"location_id" uuid REFERENCES "locations"("id") ON DELETE set null,
	"status" text DEFAULT 'in_service' NOT NULL,
	"lendable" boolean DEFAULT true NOT NULL,
	"purchased_on" text,
	"cost" real,
	"warranty_until" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "assets_tag_unique" UNIQUE("tag")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assets_location_idx" ON "assets" USING btree ("location_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "asset_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE cascade,
	"holder_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"holder_name" text NOT NULL,
	"out_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"out_at" timestamp DEFAULT now() NOT NULL,
	"due_on" text,
	"returned_at" timestamp,
	"returned_by_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
	"note" text DEFAULT '' NOT NULL,
	"return_note" text DEFAULT '' NOT NULL,
	"reminded_for" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "asset_checkouts_open_idx" ON "asset_checkouts" USING btree ("asset_id") WHERE returned_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_checkouts_asset_idx" ON "asset_checkouts" USING btree ("asset_id","out_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "asset_checkouts_holder_idx" ON "asset_checkouts" USING btree ("holder_user_id");
--> statement-breakpoint
-- The next number for an item added without a tag (A-0001, A-0002 ...).
CREATE SEQUENCE IF NOT EXISTS "assets_tag_seq" START 1;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "asset_id" uuid REFERENCES "assets"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "infra_targets" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "printers" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "racks" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE set null;
--> statement-breakpoint
-- The default grants (DEFAULT_GROUP_MODULE_ACCESS) for installs seeded before the Assets module existed: everyone can see the
-- inventory and check out to themselves, the support engineers manage it. Nothing changes a grant an admin already set.
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT id, 'assets', 'user' FROM groups WHERE name = 'user'
ON CONFLICT (group_id, module_key) DO NOTHING;
--> statement-breakpoint
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT id, 'assets', 'moderator' FROM groups WHERE name = 'support_engineer'
ON CONFLICT (group_id, module_key) DO NOTHING;
