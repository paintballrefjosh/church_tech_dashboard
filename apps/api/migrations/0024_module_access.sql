-- Schema half of the module-based access rollout (data backfill lives in
-- 0025). Cockroach refuses to use a freshly-added column in the same
-- transaction that added it, so we split.

ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "group_module_access" (
  "group_id"   uuid      NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "module_key" text      NOT NULL,
  "tier"       text      NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("group_id", "module_key")
);
