-- Cabinets (racks) and the items placed in them, for the elevation / printable cabinet pages. Additive: older code
-- ignores both tables.
CREATE TABLE IF NOT EXISTS "racks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"units" integer DEFAULT 42 NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "racks_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rack_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rack_id" uuid NOT NULL REFERENCES "racks"("id") ON DELETE cascade,
	"source_kind" text NOT NULL,
	"source_id" text,
	"label" text DEFAULT '' NOT NULL,
	"hostname" text,
	"ip" text,
	"style" text DEFAULT 'other' NOT NULL,
	"start_u" integer NOT NULL,
	"height_u" integer DEFAULT 1 NOT NULL,
	"model_id" uuid REFERENCES "switch_models"("id") ON DELETE set null,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rack_items_rack_idx" ON "rack_items" USING btree ("rack_id");
