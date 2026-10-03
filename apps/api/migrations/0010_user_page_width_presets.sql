-- Expand page_width from a 2-value toggle into a 5-value preset
-- ("fluid" | "narrow" | "standard" | "wide" | "custom"), and add an
-- optional integer pixel cap used only when the preset is "custom".
--
-- Rename "fixed" → "standard" so the names describe what they do; the new
-- default is "standard" (use each page's natural max-w-*, same behaviour as
-- the old "fixed").
UPDATE "users" SET "page_width" = 'standard' WHERE "page_width" = 'fixed';
ALTER TABLE "users" ALTER COLUMN "page_width" SET DEFAULT 'standard';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "page_width_px" integer;
