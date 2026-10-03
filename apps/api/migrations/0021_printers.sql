-- Phase 2.4 — Printers module. Stores the inventory + denormalised last-poll
-- snapshot for every Ricoh / Fiery device. The polling code in
-- apps/api/src/printers/printers.service.ts overwrites the last_* fields on
-- each tick.

CREATE TABLE IF NOT EXISTS "printers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "host" text NOT NULL,
  "kind" text NOT NULL,
  "snmp_port" integer NOT NULL DEFAULT 161,
  "snmp_version" text,
  "snmp_community" text,
  "fiery_api_url" text,
  "fiery_api_key" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "notes" text,
  "last_status" text NOT NULL DEFAULT 'unknown',
  "last_checked_at" timestamp,
  "last_error" text,
  "supplies" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "inputs" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "alerts" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "fiery_queue_depth" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "printers_enabled_idx" ON "printers" ("enabled");

-- Register the new permissions so an admin can grant them from /admin/groups
-- without re-seeding. (The seed script is idempotent and will also insert them
-- on next run, but we do it here so the migration alone leaves the system
-- usable.)
INSERT INTO "permissions" ("key") VALUES
  ('printers:read'),
  ('printers:read:any'),
  ('printers:admin')
ON CONFLICT ("key") DO NOTHING;
