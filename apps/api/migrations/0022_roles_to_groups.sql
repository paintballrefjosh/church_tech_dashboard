-- Roles → groups consolidation.
--
-- The role system (roles, role_permissions, user_roles) is being retired in
-- favour of the group system that already exists alongside it. After this
-- migration the application reads permissions from group_permissions only;
-- the role tables remain in place as a safety net and will be dropped in a
-- follow-up once the new behaviour has settled.
--
-- This migration is data-only:
--   1. Ensure a group exists with the same name as each role.
--   2. Mirror every role-permission grant into group_permissions.
--   3. Mirror every user-role assignment into group_memberships.

-- 1) Default groups (idempotent — guard against re-runs and the case where
--    an operator has already created a group with this name).
INSERT INTO groups (id, name, description, is_managed)
SELECT gen_random_uuid(),
       'admin',
       'Full access to all features and admin settings.',
       false
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'admin');

INSERT INTO groups (id, name, description, is_managed)
SELECT gen_random_uuid(),
       'support_engineer',
       'Can view all tickets, reply, modify ticket details, and moderate wiki content.',
       false
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'support_engineer');

INSERT INTO groups (id, name, description, is_managed)
SELECT gen_random_uuid(),
       'user',
       'Default group. Can create and manage own tickets, notes, and dashboard.',
       false
WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = 'user');

-- 2) Copy permissions from roles -> matching-name groups.
INSERT INTO group_permissions (group_id, permission_key)
SELECT g.id, rp.permission_key
FROM role_permissions rp
INNER JOIN roles r  ON r.id   = rp.role_id
INNER JOIN groups g ON g.name = r.key
ON CONFLICT (group_id, permission_key) DO NOTHING;

-- 3) Copy user-role assignments -> group memberships.
INSERT INTO group_memberships (group_id, user_id)
SELECT g.id, ur.user_id
FROM user_roles ur
INNER JOIN roles r  ON r.id   = ur.role_id
INNER JOIN groups g ON g.name = r.key
ON CONFLICT (group_id, user_id) DO NOTHING;
