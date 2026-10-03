-- Persist per-note placement so the notes board acts like the dashboard grid:
-- drag to rearrange, drag a corner to resize. All nullable so existing rows
-- keep auto-flow placement until the user moves them.
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "grid_x" integer;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "grid_y" integer;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "grid_w" integer;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "grid_h" integer;
