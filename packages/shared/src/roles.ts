import { PERMISSIONS, type PermissionString } from "./permissions";

export const DEFAULT_ROLES = {
  ADMIN: "admin",
  SUPPORT_ENGINEER: "support_engineer",
  USER: "user",
} as const;

export type DefaultRoleKey = (typeof DEFAULT_ROLES)[keyof typeof DEFAULT_ROLES];

/**
 * Phase 0 role -> permission mapping. Used by the seed script.
 *
 * Roles are stored in the DB and editable at runtime via the admin UI; this
 * mapping only seeds the *initial* state. Adding permissions here later
 * requires re-running the seed (idempotent — it inserts missing rows only).
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<DefaultRoleKey, readonly PermissionString[]> = {
  [DEFAULT_ROLES.ADMIN]: [
    PERMISSIONS.USERS_READ_ANY,
    PERMISSIONS.USERS_WRITE_ANY,
    PERMISSIONS.USERS_DELETE_ANY,
    PERMISSIONS.GROUPS_READ_ANY,
    PERMISSIONS.GROUPS_WRITE_ANY,
    PERMISSIONS.GROUPS_SYNC_GOOGLE,
    PERMISSIONS.ROLES_READ_ANY,
    PERMISSIONS.ROLES_WRITE_ANY,
    PERMISSIONS.PERMISSIONS_READ_ANY,
    PERMISSIONS.AUDIT_READ_ANY,
    PERMISSIONS.SETTINGS_READ_ANY,
    PERMISSIONS.SETTINGS_WRITE_ANY,
    PERMISSIONS.NOTES_READ_OWN,
    PERMISSIONS.NOTES_WRITE_OWN,
    PERMISSIONS.NOTES_DELETE_OWN,
    PERMISSIONS.NOTES_READ_ANY,
  ],
  [DEFAULT_ROLES.SUPPORT_ENGINEER]: [
    PERMISSIONS.USERS_READ_ANY,
    PERMISSIONS.GROUPS_READ_ANY,
    PERMISSIONS.AUDIT_READ_ANY,
    PERMISSIONS.NOTES_READ_OWN,
    PERMISSIONS.NOTES_WRITE_OWN,
    PERMISSIONS.NOTES_DELETE_OWN,
  ],
  [DEFAULT_ROLES.USER]: [
    PERMISSIONS.NOTES_READ_OWN,
    PERMISSIONS.NOTES_WRITE_OWN,
    PERMISSIONS.NOTES_DELETE_OWN,
  ],
};

export const DEFAULT_ROLE_DESCRIPTIONS: Record<DefaultRoleKey, string> = {
  [DEFAULT_ROLES.ADMIN]: "Full access to all features and admin settings.",
  [DEFAULT_ROLES.SUPPORT_ENGINEER]: "Can view all tickets, reply, and modify ticket details.",
  [DEFAULT_ROLES.USER]: "Default role. Can create and manage own tickets, notes, and dashboard.",
};

/** TOTP is required for any user holding a role in this set. */
export const ROLES_REQUIRING_TOTP: readonly DefaultRoleKey[] = [DEFAULT_ROLES.ADMIN];
