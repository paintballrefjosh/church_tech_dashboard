-- Server-side sign-out: a session cookie carries the version it was issued under and stops working when the
-- account's version is bumped (password change or reset, 2FA reset). Every account starts at 0.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The 30-second step of the last accepted TOTP code, so a code cannot be used twice.
ALTER TABLE "totp_secrets" ADD COLUMN IF NOT EXISTS "last_step" bigint;
