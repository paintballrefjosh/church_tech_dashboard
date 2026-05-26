/**
 * Permission strings use the pattern: <resource>:<verb>:<scope>
 *   - resource: domain noun (users, groups, roles, tickets, ...)
 *   - verb:    read | write | delete | <action>
 *   - scope:   any | own | <group-id-template>
 *
 * Add new permissions here as new modules land. Never hard-code role names in
 * business logic — gate on permission strings.
 */
export const PERMISSIONS = {
  // Users
  USERS_READ_ANY: "users:read:any",
  USERS_WRITE_ANY: "users:write:any",
  USERS_DELETE_ANY: "users:delete:any",

  // Groups
  GROUPS_READ_ANY: "groups:read:any",
  GROUPS_WRITE_ANY: "groups:write:any",
  GROUPS_SYNC_GOOGLE: "groups:sync:google",

  // Roles & permissions
  ROLES_READ_ANY: "roles:read:any",
  ROLES_WRITE_ANY: "roles:write:any",
  PERMISSIONS_READ_ANY: "permissions:read:any",

  // Audit log
  AUDIT_READ_ANY: "audit:read:any",

  // Site settings
  SETTINGS_READ_ANY: "settings:read:any",
  SETTINGS_WRITE_ANY: "settings:write:any",

  // Notes — owner-only for Phase 1.1. ANY-scope grants admins a future
  // moderation surface; the controller currently only honours OWN.
  NOTES_READ_OWN: "notes:read:own",
  NOTES_WRITE_OWN: "notes:write:own",
  NOTES_DELETE_OWN: "notes:delete:own",
  NOTES_READ_ANY: "notes:read:any",
} as const;

export type PermissionString = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly PermissionString[] = Object.values(PERMISSIONS) as PermissionString[];
