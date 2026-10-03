-- Per-switch alert preferences: which transition categories fire notifications.
-- Empty object = all off (no alerts) until the operator opts in on the switch
-- form. Single ADD COLUMN with a constant default — no follow-up UPDATE, so
-- CockroachDB's async backfill is fine.
ALTER TABLE cisco_switches ADD COLUMN IF NOT EXISTS alert_prefs jsonb NOT NULL DEFAULT '{}';
