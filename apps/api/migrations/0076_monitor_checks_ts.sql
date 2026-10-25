-- The probe worker prunes monitor_checks by age in batches; without an index on ts alone every batch scanned the table.
CREATE INDEX IF NOT EXISTS "monitor_checks_ts_idx" ON "monitor_checks" USING btree ("ts");
