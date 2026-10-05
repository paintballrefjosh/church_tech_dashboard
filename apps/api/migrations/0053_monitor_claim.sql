ALTER TABLE "monitors" ADD COLUMN IF NOT EXISTS "claimed_until" timestamp with time zone;
