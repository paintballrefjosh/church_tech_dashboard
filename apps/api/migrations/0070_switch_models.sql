-- Switch models for the switch view: a front and a back picture (attachments), which side has the ports, and a box per
-- port as a fraction of the picture. Additive: older code ignores the table.
CREATE TABLE IF NOT EXISTS "switch_models" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"match" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"port_side" text DEFAULT 'front' NOT NULL,
	"front_image_id" uuid REFERENCES "attachments"("id") ON DELETE set null,
	"back_image_id" uuid REFERENCES "attachments"("id") ON DELETE set null,
	"front_width" integer,
	"front_height" integer,
	"back_width" integer,
	"back_height" integer,
	"ports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "switch_models_name_unique" UNIQUE("name")
);
