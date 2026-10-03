-- Per-user UI preference: "fixed" (current centred/capped layout) or "fluid"
-- (full viewport width). Defaults to "fixed" so existing users see no change.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "page_width" text NOT NULL DEFAULT 'fixed';
