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

  // Helpdesk / tickets (Phase 1.3). OWN = the tickets a user opened;
  // ANY = every ticket in the system. Comments inherit ticket visibility,
  // except COMMENTS_WRITE_INTERNAL which gates the "internal note" flag
  // (notes visible only to support_engineer + admin).
  TICKETS_READ_OWN: "tickets:read:own",
  TICKETS_WRITE_OWN: "tickets:write:own",
  TICKETS_READ_ANY: "tickets:read:any",
  TICKETS_WRITE_ANY: "tickets:write:any",
  TICKETS_ASSIGN: "tickets:assign",
  TICKETS_DELETE_ANY: "tickets:delete:any",
  TICKET_COMMENTS_WRITE_INTERNAL: "ticket_comments:write:internal",

  // Wiki (Phase 1.4). 'own' here means "the page owner OR a user with edit
  // access via a wiki_page_acl row". Reading a public page requires only
  // WIKI_READ_OWN; reading a 'group'-visibility page additionally requires
  // membership in one of its ACL groups (or WIKI_READ_ANY).
  WIKI_CREATE: "wiki:create",
  WIKI_READ_OWN: "wiki:read:own",
  WIKI_WRITE_OWN: "wiki:write:own",
  WIKI_DELETE_OWN: "wiki:delete:own",
  WIKI_READ_ANY: "wiki:read:any",
  WIKI_WRITE_ANY: "wiki:write:any",
  WIKI_DELETE_ANY: "wiki:delete:any",
} as const;

export type PermissionString = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly PermissionString[] = Object.values(PERMISSIONS) as PermissionString[];
