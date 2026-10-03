-- Merge the `network` module into `monitoring`. The UniFi views moved under
-- the Monitoring section (Network tab) and their permissions now ride the
-- monitoring tier (see packages/shared/src/modules.ts). Any group that held a
-- `network` grant must keep equivalent access, so we upsert a `monitoring`
-- grant at the higher of (existing monitoring tier, old network tier), then
-- drop the now-dead `network` rows.
--
-- tier ranking: user < moderator < admin. Cockroach supports ON CONFLICT ...
-- DO UPDATE with `excluded`, which we use to take the max tier.
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT n.group_id, 'monitoring', n.tier
FROM group_module_access n
WHERE n.module_key = 'network'
ON CONFLICT (group_id, module_key) DO UPDATE
SET tier = CASE
  WHEN (CASE excluded.tier WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END)
     > (CASE group_module_access.tier WHEN 'admin' THEN 3 WHEN 'moderator' THEN 2 ELSE 1 END)
  THEN excluded.tier
  ELSE group_module_access.tier
END;--> statement-breakpoint
DELETE FROM group_module_access WHERE module_key = 'network';
