-- Update runs may also remove packages nothing needs any more (apt/dnf/yum autoremove) after a successful upgrade.
ALTER TABLE "infra_update_runs" ADD COLUMN IF NOT EXISTS "cleanup" boolean DEFAULT false NOT NULL;
