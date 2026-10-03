-- Per-user notification mute list. Kinds in this array are skipped entirely by
-- NotificationsService.create() — no row, no realtime push, no email. Defaults
-- to empty (everything enabled). One column instead of a join table because
-- the catalogue is tiny and lookup is per-create on the hot path.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "muted_notification_kinds" text[] NOT NULL DEFAULT ARRAY[]::text[];
