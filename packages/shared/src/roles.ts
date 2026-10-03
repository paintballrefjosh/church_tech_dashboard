/**
 * Default groups seeded on a fresh DB and used by the OAuth provisioning
 * hook + reset scripts. The role system was retired in favour of groups
 * (migration 0022); per-permission grants gave way to per-module tiered
 * access in migration 0024 (see ./modules.ts → DEFAULT_GROUP_MODULE_ACCESS).
 * The legacy role + group_permissions tables remain in the DB as a safety
 * net but are no longer read.
 */
export const DEFAULT_GROUPS = {
  ADMIN: "admin",
  SUPPORT_ENGINEER: "support_engineer",
  USER: "user",
} as const;

export type DefaultGroupKey = (typeof DEFAULT_GROUPS)[keyof typeof DEFAULT_GROUPS];

export const DEFAULT_GROUP_DESCRIPTIONS: Record<DefaultGroupKey, string> = {
  [DEFAULT_GROUPS.ADMIN]:
    "Full access to every module. Cannot be deleted or edited.",
  [DEFAULT_GROUPS.SUPPORT_ENGINEER]:
    "Moderates tickets/wiki/monitoring; baseline access to most other modules.",
  [DEFAULT_GROUPS.USER]:
    "Default group joined by every newly provisioned user. Cannot be deleted.",
};
