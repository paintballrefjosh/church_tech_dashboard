-- Fix-up: 0018 forwarded `tickets:categories:read` to anyone with
-- `tickets:read:own`, which over-granted the menu visibility for the
-- /admin/ticket-categories page to regular users. The catalogue admin page
-- only needs to be visible to roles that can either manage the catalogue
-- (tickets:categories:admin) or already see every ticket (tickets:read:any).
--
-- IDEMPOTENT: deletes only the over-granted rows; safe to re-run.

DELETE FROM "role_permissions"
WHERE permission_key = 'tickets:categories:read'
  AND role_id NOT IN (
    SELECT role_id FROM "role_permissions"
    WHERE permission_key IN ('tickets:categories:admin','tickets:read:any')
  );

DELETE FROM "group_permissions"
WHERE permission_key = 'tickets:categories:read'
  AND group_id NOT IN (
    SELECT group_id FROM "group_permissions"
    WHERE permission_key IN ('tickets:categories:admin','tickets:read:any')
  );
