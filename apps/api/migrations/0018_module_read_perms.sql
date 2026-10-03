-- Phase 1.4+ — add `<module>:read` permissions used to gate menu visibility.
-- These are additive flags (existing :read:own / :read:any still gate the API);
-- the web layer hides the top-bar / admin links if the flag is missing.
--
-- IDEMPOTENT: ON CONFLICT DO NOTHING everywhere so re-runs are safe.

-- 1. Insert the seven new menu-visibility permissions.
INSERT INTO "permissions" ("key") VALUES
  ('user:read'),
  ('site:read'),
  ('tickets:read'),
  ('tickets:categories:read'),
  ('wiki:read'),
  ('planning_center:read'),
  ('propresenter:read')
ON CONFLICT ("key") DO NOTHING;

-- 2. Forward existing grants onto the new flags so nobody silently loses a
--    menu link. The mapping is "if you have any of the source perms, you get
--    the new :read perm too." Done per-role and per-group.

-- tickets:read — granted to anyone who can read tickets in any scope OR admin.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'tickets:read' FROM "role_permissions"
  WHERE permission_key IN ('tickets:read:own','tickets:read:any','tickets:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'tickets:read' FROM "group_permissions"
  WHERE permission_key IN ('tickets:read:own','tickets:read:any','tickets:admin')
ON CONFLICT DO NOTHING;

-- tickets:categories:read — granted to anyone with the categories admin perm,
-- or anyone who can read tickets at all (categories show up on tickets).
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'tickets:categories:read' FROM "role_permissions"
  WHERE permission_key IN ('tickets:categories:admin','tickets:read:own','tickets:read:any','tickets:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'tickets:categories:read' FROM "group_permissions"
  WHERE permission_key IN ('tickets:categories:admin','tickets:read:own','tickets:read:any','tickets:admin')
ON CONFLICT DO NOTHING;

-- wiki:read — any wiki read access OR admin.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'wiki:read' FROM "role_permissions"
  WHERE permission_key IN ('wiki:read:own','wiki:read:any','wiki:admin','wiki:create')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'wiki:read' FROM "group_permissions"
  WHERE permission_key IN ('wiki:read:own','wiki:read:any','wiki:admin','wiki:create')
ON CONFLICT DO NOTHING;

-- site:read — anyone who can read settings OR is a site admin.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'site:read' FROM "role_permissions"
  WHERE permission_key IN ('settings:read:any','site:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'site:read' FROM "group_permissions"
  WHERE permission_key IN ('settings:read:any','site:admin')
ON CONFLICT DO NOTHING;

-- user:read — anyone who can usefully see the people-management surface.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'user:read' FROM "role_permissions"
  WHERE permission_key IN ('users:read:any','groups:read:any','roles:read:any','permissions:read:any','user:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'user:read' FROM "group_permissions"
  WHERE permission_key IN ('users:read:any','groups:read:any','roles:read:any','permissions:read:any','user:admin')
ON CONFLICT DO NOTHING;

-- planning_center:read — read access OR admin.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'planning_center:read' FROM "role_permissions"
  WHERE permission_key IN ('planning_center:read:any','planning_center:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'planning_center:read' FROM "group_permissions"
  WHERE permission_key IN ('planning_center:read:any','planning_center:admin')
ON CONFLICT DO NOTHING;

-- propresenter:read — read access OR admin.
INSERT INTO "role_permissions" ("role_id", "permission_key")
  SELECT DISTINCT role_id, 'propresenter:read' FROM "role_permissions"
  WHERE permission_key IN ('propresenter:read:any','propresenter:admin')
ON CONFLICT DO NOTHING;
INSERT INTO "group_permissions" ("group_id", "permission_key")
  SELECT DISTINCT group_id, 'propresenter:read' FROM "group_permissions"
  WHERE permission_key IN ('propresenter:read:any','propresenter:admin')
ON CONFLICT DO NOTHING;
