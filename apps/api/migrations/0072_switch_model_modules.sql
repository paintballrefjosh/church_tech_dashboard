-- Add-on modules for switch models: a model is a "switch" or a "module" (a network module with a picture and ports of
-- its own), and a switch model lists the modules placed on its picture. Additive: older code ignores both columns, and
-- every existing row is a switch with no modules.
ALTER TABLE "switch_models" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'switch' NOT NULL;
--> statement-breakpoint
ALTER TABLE "switch_models" ADD COLUMN IF NOT EXISTS "modules" jsonb DEFAULT '[]'::jsonb NOT NULL;
