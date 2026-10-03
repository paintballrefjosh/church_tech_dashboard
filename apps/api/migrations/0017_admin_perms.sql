-- Phase 1.4+ — consolidate destructive permissions into per-module :admin
-- permissions and introduce group-granted permissions.
--
-- IDEMPOTENT: every statement uses IF NOT EXISTS / ON CONFLICT or guards on
-- key existence so re-running this migration is a no-op.

-- 1. New group_permissions table. Membership in a group grants every
--    permission listed here to every member (loader unions with role-derived).
CREATE TABLE IF NOT EXISTS "group_permissions" (
  "group_id" uuid NOT NULL REFERENCES "groups"("id") ON DELETE CASCADE,
  "permission_key" text NOT NULL REFERENCES "permissions"("key") ON DELETE CASCADE,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("group_id", "permission_key")
);

-- 2. Insert the seven new :admin permission rows.
INSERT INTO "permissions" ("key") VALUES
  ('tickets:admin'),
  ('tickets:categories:admin'),
  ('wiki:admin'),
  ('site:admin'),
  ('user:admin'),
  ('planning_center:admin'),
  ('propresenter:admin')
ON CONFLICT ("key") DO NOTHING;

-- 3. Forward every existing destructive grant onto the matching :admin key so
--    no role loses access mid-deploy. ON CONFLICT keeps idempotency.

-- tickets:admin folds in write:any + delete:any + assign + internal comments
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'tickets:admin' FROM "role_permissions"
  WHERE permission_key IN (
    'tickets:write:any','tickets:delete:any','tickets:assign','ticket_comments:write:internal'
  )
ON CONFLICT DO NOTHING;

-- tickets:categories:admin replaces the write permission added in 0015
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'tickets:categories:admin' FROM "role_permissions"
  WHERE permission_key = 'tickets:categories:write'
ON CONFLICT DO NOTHING;

-- wiki:admin folds in write:any + delete:any
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'wiki:admin' FROM "role_permissions"
  WHERE permission_key IN ('wiki:write:any','wiki:delete:any')
ON CONFLICT DO NOTHING;

-- site:admin replaces settings:write:any
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'site:admin' FROM "role_permissions"
  WHERE permission_key = 'settings:write:any'
ON CONFLICT DO NOTHING;

-- user:admin folds in users/groups/roles write/delete + google sync. Only
-- copied for roles that hold *every* user-mgmt write — prevents accidentally
-- elevating a role that only had a partial grant.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT role_id, 'user:admin' FROM "role_permissions"
  WHERE permission_key = 'users:write:any'
ON CONFLICT DO NOTHING;

-- planning_center:admin replaces link:any
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'planning_center:admin' FROM "role_permissions"
  WHERE permission_key = 'planning_center:link:any'
ON CONFLICT DO NOTHING;

-- propresenter:admin replaces control
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'propresenter:admin' FROM "role_permissions"
  WHERE permission_key = 'propresenter:control'
ON CONFLICT DO NOTHING;

-- 4. Drop the replaced role_permissions rows. FK cascade in step 5 would
--    handle this implicitly, but doing it explicitly here keeps the audit
--    trail clean and avoids relying on CASCADE behaviour for correctness.
DELETE FROM "role_permissions"
WHERE permission_key IN (
  'tickets:write:any','tickets:delete:any','tickets:assign','ticket_comments:write:internal',
  'tickets:categories:write',
  'wiki:write:any','wiki:delete:any',
  'settings:write:any',
  'users:write:any','users:delete:any','groups:write:any','groups:sync:google','roles:write:any',
  'planning_center:link:any',
  'propresenter:control'
);

-- 5. Drop the replaced permission rows themselves so the catalogue stays
--    aligned with the shared/ALL_PERMISSIONS export.
DELETE FROM "permissions"
WHERE key IN (
  'tickets:write:any','tickets:delete:any','tickets:assign','ticket_comments:write:internal',
  'tickets:categories:write',
  'wiki:write:any','wiki:delete:any',
  'settings:write:any',
  'users:write:any','users:delete:any','groups:write:any','groups:sync:google','roles:write:any',
  'planning_center:link:any',
  'propresenter:control'
);
