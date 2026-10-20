-- Which switch model draws a switch's picture, when an admin picked one (null = decided by the model text), and a switch
-- the admin turned the picture off for. Additive: older code ignores both columns.
ALTER TABLE "cisco_switches" ADD COLUMN IF NOT EXISTS "switch_model_id" uuid REFERENCES "switch_models"("id") ON DELETE set null;
--> statement-breakpoint
ALTER TABLE "cisco_switches" ADD COLUMN IF NOT EXISTS "switch_view_off" boolean DEFAULT false NOT NULL;
