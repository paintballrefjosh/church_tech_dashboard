-- What each PoE port is delivering, read from `show power inline module N detail` on every poll (null = no PoE reading). Additive.
ALTER TABLE "cisco_port_live_state" ADD COLUMN IF NOT EXISTS "poe_status" text;--> statement-breakpoint
ALTER TABLE "cisco_port_live_state" ADD COLUMN IF NOT EXISTS "poe_device" text;--> statement-breakpoint
ALTER TABLE "cisco_port_live_state" ADD COLUMN IF NOT EXISTS "poe_class" integer;--> statement-breakpoint
ALTER TABLE "cisco_port_live_state" ADD COLUMN IF NOT EXISTS "poe_allocated_mw" integer;--> statement-breakpoint
ALTER TABLE "cisco_port_live_state" ADD COLUMN IF NOT EXISTS "poe_measured_mw" integer;
