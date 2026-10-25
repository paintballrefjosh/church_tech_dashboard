-- Equipment for the staff an install already has, judged by what each group may do rather than by its name: 0082 granted
-- the Assets moderator tier only to a group called `support_engineer`, which installs rename or remove. Every non-system
-- group that moderates Tickets or Monitoring (moderator or admin tier) gets Assets at moderator. A grant an admin already
-- set is left alone; the admin group is special-cased in code and the user group keeps its user tier from 0082.
INSERT INTO group_module_access (group_id, module_key, tier)
SELECT DISTINCT g.id, 'assets', 'moderator'
FROM groups g
JOIN group_module_access a ON a.group_id = g.id
WHERE g.is_system = false
  AND a.module_key IN ('tickets', 'monitoring')
  AND a.tier IN ('moderator', 'admin')
ON CONFLICT (group_id, module_key) DO NOTHING;
