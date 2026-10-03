-- Drop five "menu-visibility" permission strings that were defined and seeded
-- but never actually checked by any code:
--   tickets:read, wiki:read, propresenter:read, planning_center:read, printers:read
--
-- The granular *:read:any / *:read:own / *:admin permissions cover every real
-- gate; the bare :read flags were intended as cheap "should this menu link
-- render" hints but the topbar nav settled on checking the granular set
-- directly. The DELETE cascades into group_permissions (and the legacy
-- role_permissions table) via the existing FK with ON DELETE CASCADE.

DELETE FROM permissions
WHERE key IN (
  'tickets:read',
  'wiki:read',
  'propresenter:read',
  'planning_center:read',
  'printers:read'
);
