-- Infra targets move from a single `kind` discriminator to an `os` axis plus a
-- set of toggleable `capabilities`. `kind` stays as a derived shadow column.
--
-- Columns are added with constant DEFAULTs only — NO UPDATE. drizzle runs the
-- whole pending batch in one transaction, and CockroachDB won't let a statement
-- reference a column added earlier in the same transaction ("being
-- backfilled"). So we can't backfill kind->capabilities here; instead the read
-- path (infra.service toTarget) derives capabilities from `kind` for any row
-- whose capabilities is still empty. New rows always write both columns.
ALTER TABLE infra_targets ADD COLUMN IF NOT EXISTS os text NOT NULL DEFAULT 'linux';--> statement-breakpoint
ALTER TABLE infra_targets ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';
