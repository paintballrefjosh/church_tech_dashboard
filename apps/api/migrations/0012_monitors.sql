-- Phase 2.1 — monitoring. Three tables:
--   monitors            user-defined config + denormalised current state
--   monitor_checks      append-only per-check log (sparkline source)
--   monitor_incidents   open/closed state-change records

CREATE TABLE IF NOT EXISTS "monitors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "target" text NOT NULL,
  "interval_sec" integer NOT NULL DEFAULT 60,
  "fail_threshold" integer NOT NULL DEFAULT 2,
  "recover_threshold" integer NOT NULL DEFAULT 2,
  "options" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "enabled" boolean NOT NULL DEFAULT true,
  "status" text NOT NULL DEFAULT 'unknown',
  "last_checked_at" timestamp,
  "last_latency_ms" integer,
  "consecutive_fails" integer NOT NULL DEFAULT 0,
  "consecutive_oks" integer NOT NULL DEFAULT 0,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "monitors_enabled_idx" ON "monitors" ("enabled");

CREATE TABLE IF NOT EXISTS "monitor_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "monitor_id" uuid NOT NULL REFERENCES "monitors"("id") ON DELETE CASCADE,
  "ok" boolean NOT NULL,
  "latency_ms" integer,
  "info" text,
  "ts" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "monitor_checks_monitor_ts_idx"
  ON "monitor_checks" ("monitor_id", "ts");

CREATE TABLE IF NOT EXISTS "monitor_incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "monitor_id" uuid NOT NULL REFERENCES "monitors"("id") ON DELETE CASCADE,
  "started_at" timestamp NOT NULL DEFAULT now(),
  "resolved_at" timestamp,
  "reason" text
);

CREATE INDEX IF NOT EXISTS "monitor_incidents_open_idx"
  ON "monitor_incidents" ("monitor_id", "resolved_at");
