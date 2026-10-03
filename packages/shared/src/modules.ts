import { PERMISSIONS, type PermissionString } from "./permissions";

/**
 * Module-based access model.
 *
 * Each addressable surface in the app — feature module or admin surface — is
 * a "module". A group is assigned zero or more modules, with a tier for each.
 *
 *   - user      = baseline access to the module (own-scoped capabilities)
 *   - moderator = see / curate everyone's content within the module
 *   - admin     = destructive operations + configuration within the module
 *
 * Higher tiers ALWAYS inherit lower ones (admin gets moderator + user).
 * The `permissionsByTier` map below only lists the *additional* permission
 * strings each tier brings; `permissionsFor` rolls them up.
 *
 * The "admin" module is the catch-all for site administration (settings,
 * users + groups, audit log, etc.) and only offers a single `admin` tier —
 * you're either a full site admin or you aren't.
 *
 * Permission strings remain the implementation detail the API checks; the
 * (module, tier) tuple is the user-facing concept on the group editor.
 */
export const MODULE_TIERS = ["user", "moderator", "admin"] as const;
export type ModuleTier = (typeof MODULE_TIERS)[number];

export interface ModuleDefinition {
  key: string;
  label: string;
  description: string;
  /** The tiers this module actually offers. Most modules expose all three; "admin" exposes only ["admin"]. */
  tiers: readonly ModuleTier[];
  /** Extra permissions each tier brings (not cumulative — `permissionsFor` does the roll-up). */
  permissionsByTier: { [T in ModuleTier]?: readonly PermissionString[] };
}

export const MODULES: readonly ModuleDefinition[] = [
  {
    key: "notes",
    label: "Notes",
    description: "Personal sticky-note board.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [
        PERMISSIONS.NOTES_READ_OWN,
        PERMISSIONS.NOTES_WRITE_OWN,
        PERMISSIONS.NOTES_DELETE_OWN,
      ],
      moderator: [PERMISSIONS.NOTES_READ_ANY],
      admin: [],
    },
  },
  {
    key: "tickets",
    label: "Helpdesk",
    description: "Tickets, replies, categories.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [PERMISSIONS.TICKETS_READ_OWN, PERMISSIONS.TICKETS_WRITE_OWN],
      moderator: [
        PERMISSIONS.TICKETS_READ_ANY,
        PERMISSIONS.TICKETS_CATEGORIES_READ,
      ],
      admin: [PERMISSIONS.TICKETS_ADMIN, PERMISSIONS.TICKETS_CATEGORIES_ADMIN],
    },
  },
  {
    key: "wiki",
    label: "Wiki",
    description: "Shared knowledge base.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [
        PERMISSIONS.WIKI_CREATE,
        PERMISSIONS.WIKI_READ_OWN,
        PERMISSIONS.WIKI_WRITE_OWN,
        PERMISSIONS.WIKI_DELETE_OWN,
      ],
      moderator: [PERMISSIONS.WIKI_READ_ANY],
      admin: [PERMISSIONS.WIKI_ADMIN],
    },
  },
  {
    key: "monitoring",
    label: "Monitoring",
    description: "Service uptime, infrastructure resources, and UniFi network views.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      // The `network` module was folded into `monitoring` — its UniFi
      // permissions are granted here so the Network tab and /admin/settings
      // ride the monitoring tier.
      user: [PERMISSIONS.MONITORS_READ_ANY, PERMISSIONS.UNIFI_READ_ANY],
      moderator: [],
      admin: [PERMISSIONS.MONITORS_WRITE_ANY, PERMISSIONS.UNIFI_ADMIN],
    },
  },
  {
    key: "printers",
    label: "Printers",
    description: "Ricoh + Fiery devices.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [PERMISSIONS.PRINTERS_READ_ANY],
      moderator: [],
      admin: [PERMISSIONS.PRINTERS_ADMIN],
    },
  },
  // NOTE: the former `network` module was merged into `monitoring` (see above).
  // Its UniFi views now live under the Monitoring section's Network tab, and
  // its permissions ride the monitoring tier. Migration 0031 folds existing
  // group grants across.
  {
    key: "propresenter",
    label: "ProPresenter",
    description: "Live worship remote.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [PERMISSIONS.PROPRESENTER_READ_ANY],
      moderator: [],
      admin: [PERMISSIONS.PROPRESENTER_ADMIN],
    },
  },
  {
    key: "planning_center",
    label: "Planning Center",
    description: "Services, teams, schedules.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [PERMISSIONS.PLANNING_CENTER_READ_ANY],
      moderator: [],
      admin: [PERMISSIONS.PLANNING_CENTER_ADMIN],
    },
  },
  {
    key: "checklists",
    label: "Checklists",
    description: "Volunteer task lists per event.",
    tiers: ["user", "moderator", "admin"],
    permissionsByTier: {
      user: [PERMISSIONS.CHECKLISTS_READ_ASSIGNED],
      // Moderator is the "station / kiosk" tier: read any event + complete any
      // station's tasks. Put shared tablet accounts in a group set to this tier.
      moderator: [PERMISSIONS.CHECKLISTS_READ_ANY, PERMISSIONS.CHECKLISTS_COMPLETE_ANY],
      admin: [PERMISSIONS.CHECKLISTS_ADMIN],
    },
  },
  {
    key: "admin",
    label: "Administration",
    description: "Site settings, users/groups, audit log, OAuth, SMTP, network config.",
    tiers: ["admin"],
    permissionsByTier: {
      admin: [
        PERMISSIONS.USERS_READ_ANY,
        PERMISSIONS.GROUPS_READ_ANY,
        PERMISSIONS.ROLES_READ_ANY,
        PERMISSIONS.PERMISSIONS_READ_ANY,
        PERMISSIONS.USER_READ,
        PERMISSIONS.USER_ADMIN,
        PERMISSIONS.AUDIT_READ_ANY,
        PERMISSIONS.SETTINGS_READ_ANY,
        PERMISSIONS.SITE_READ,
        PERMISSIONS.SITE_ADMIN,
        PERMISSIONS.TAGS_READ_ANY,
        PERMISSIONS.TAGS_WRITE_ANY,
      ],
    },
  },
] as const;

export type ModuleKey = (typeof MODULES)[number]["key"];

export const ALL_MODULE_KEYS: readonly string[] = MODULES.map((m) => m.key);

/** Find a module definition by key; null when the key isn't in the catalog. */
export function findModule(key: string): ModuleDefinition | null {
  return MODULES.find((m) => m.key === key) ?? null;
}

/**
 * Expand a (module, tier) selection into the flat list of permission strings
 * it grants. Higher tiers include everything lower tiers grant.
 *
 *   permissionsFor("tickets", "moderator")  ->  user + moderator perms
 *   permissionsFor("admin",   "admin")      ->  every admin-module perm
 */
export function permissionsFor(moduleKey: string, tier: ModuleTier): PermissionString[] {
  const def = findModule(moduleKey);
  if (!def) return [];
  // Only roll up tiers up to and including the requested one. The module's
  // `tiers` array carries the canonical order (user → moderator → admin).
  const out = new Set<PermissionString>();
  for (const t of def.tiers) {
    for (const p of def.permissionsByTier[t] ?? []) out.add(p);
    if (t === tier) return [...out];
  }
  // Tier wasn't valid for this module; return what we collected.
  return [...out];
}

/** Numeric rank so callers can compare tiers (admin > moderator > user). */
export function tierRank(moduleKey: string, tier: ModuleTier): number {
  const def = findModule(moduleKey);
  if (!def) return -1;
  return def.tiers.indexOf(tier);
}

/**
 * Default module access for the three seeded groups. Used by the seed
 * script + migration backfill. Each group is independent — no implicit
 * inheritance between groups.
 */
export const DEFAULT_GROUP_MODULE_ACCESS: Record<string, Record<string, ModuleTier>> = {
  admin: {
    notes: "admin",
    tickets: "admin",
    wiki: "admin",
    monitoring: "admin",
    printers: "admin",
    propresenter: "admin",
    planning_center: "admin",
    checklists: "admin",
    admin: "admin",
  },
  support_engineer: {
    notes: "user",
    tickets: "admin",
    wiki: "admin",
    monitoring: "admin",
    printers: "user",
    propresenter: "user",
    planning_center: "user",
    checklists: "moderator",
  },
  user: {
    notes: "user",
    tickets: "user",
    wiki: "user",
    monitoring: "user",
    printers: "user",
    planning_center: "user",
    checklists: "user",
  },
};
