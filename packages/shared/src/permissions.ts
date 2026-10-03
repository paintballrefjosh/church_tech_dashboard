/**
 * Permission strings use the pattern: <resource>:<verb>:<scope>
 *   - resource: domain noun (users, groups, roles, tickets, ...)
 *   - verb:    read | write | delete | admin | <action>
 *   - scope:   any | own | <group-id-template>
 *
 * Convention: each module has one consolidated `:admin` permission that
 * implies every destructive capability for that module (create + edit +
 * delete + any sub-resource management). Granular :write:any / :delete:any
 * permissions only exist where partial admin is actually useful (e.g.
 * notes own-scoped, ticket own-scoped, monitors write).
 *
 * Add new permissions here as new modules land. Never hard-code role names in
 * business logic — gate on permission strings.
 */
export const PERMISSIONS = {
  // Users / Groups / Roles — folded into one user:admin permission so the
  // "people management" surface is granted as a single grant. Reads remain
  // separate so non-admins can be allowed to see the directory.
  USERS_READ_ANY: "users:read:any",
  GROUPS_READ_ANY: "groups:read:any",
  ROLES_READ_ANY: "roles:read:any",
  PERMISSIONS_READ_ANY: "permissions:read:any",
  /**
   * Menu-visibility flag for the people-management surface (/admin/users,
   * /admin/groups, /admin/permissions). Granted to anyone who can usefully
   * see any of those pages; the API endpoints still gate on the granular
   * permissions above.
   */
  USER_READ: "user:read",
  /**
   * Full control of the people graph: create/edit/delete users, create/edit
   * groups, assign roles, assign permissions to groups, sync Google groups.
   * Most powerful permission in the system — only ever grant to true admins.
   */
  USER_ADMIN: "user:admin",

  // Audit log
  AUDIT_READ_ANY: "audit:read:any",

  // Site settings — site:admin gates anything that mutates global config
  // (Google OAuth client, SMTP, site name, etc.).
  SETTINGS_READ_ANY: "settings:read:any",
  /** Menu-visibility flag for /admin/settings and the site config surface. */
  SITE_READ: "site:read",
  SITE_ADMIN: "site:admin",

  // Notes — owner-only. ANY-scope grants admins a future moderation surface;
  // the controller currently only honours OWN.
  NOTES_READ_OWN: "notes:read:own",
  NOTES_WRITE_OWN: "notes:write:own",
  NOTES_DELETE_OWN: "notes:delete:own",
  NOTES_READ_ANY: "notes:read:any",

  // Helpdesk / tickets. OWN = the tickets a user opened (create, edit, close);
  // ANY-read = view everyone's tickets without acting on them; ADMIN = full
  // write/delete/assign + internal-comment privilege + category catalogue.
  TICKETS_READ_OWN: "tickets:read:own",
  TICKETS_WRITE_OWN: "tickets:write:own",
  TICKETS_READ_ANY: "tickets:read:any",
  TICKETS_ADMIN: "tickets:admin",
  /** Menu-visibility flag for the ticket-categories admin page. */
  TICKETS_CATEGORIES_READ: "tickets:categories:read",
  /** Manage the ticket-category catalogue (create/edit/delete). */
  TICKETS_CATEGORIES_ADMIN: "tickets:categories:admin",

  // Wiki. 'own' here means "the page owner OR a user with edit access via a
  // wiki_page_acl row". Reading a public page requires only WIKI_READ_OWN;
  // reading a 'group'-visibility page additionally requires membership in one
  // of its ACL groups (or WIKI_READ_ANY). WIKI_ADMIN folds in the
  // moderate-anyone-elses-pages capability.
  WIKI_CREATE: "wiki:create",
  WIKI_READ_OWN: "wiki:read:own",
  WIKI_WRITE_OWN: "wiki:write:own",
  WIKI_DELETE_OWN: "wiki:delete:own",
  WIKI_READ_ANY: "wiki:read:any",
  WIKI_ADMIN: "wiki:admin",

  // Monitors. Read is broad — anyone signed in can see up/down status; write
  // is gated to admins + support staff.
  MONITORS_READ_ANY: "monitors:read:any",
  MONITORS_WRITE_ANY: "monitors:write:any",

  // Printers — Ricoh devices + Fiery print server. READ = see status; ADMIN =
  // add/edit/remove printer entries and credentials. Status is intentionally
  // broad-readable so non-admin staff can answer "is it broken" without help.
  PRINTERS_READ_ANY: "printers:read:any",
  PRINTERS_ADMIN: "printers:admin",

  // UniFi network read-only views. No write — we never push config back to
  // the controller. ADMIN gates managing the UniFi integration settings
  // (controller URL, API key, site id) — not pushing device config.
  UNIFI_READ_ANY: "unifi:read:any",
  UNIFI_ADMIN: "unifi:admin",

  // ProPresenter live remote. Read = see current slide/state; ADMIN = control
  // (next/prev/clear) and configuration.
  PROPRESENTER_READ_ANY: "propresenter:read:any",
  PROPRESENTER_ADMIN: "propresenter:admin",

  // Tags. Read is universal — anyone signed in can see the catalogue and use
  // tags they can read on resources they already have access to. Write gates
  // creating/editing tag definitions; assigning a tag to a resource is
  // delegated to that resource's edit permission.
  TAGS_READ_ANY: "tags:read:any",
  TAGS_WRITE_ANY: "tags:write:any",

  // Planning Center. Read = view services, plans, positions, assignments.
  // ADMIN = map any local user to a PC person; self-link is gated by being
  // signed in (no separate permission).
  PLANNING_CENTER_READ_ANY: "planning_center:read:any",
  PLANNING_CENTER_ADMIN: "planning_center:admin",

  // Checklists. ASSIGNED = see events you're rostered on + tick your stations'
  // boxes. READ_ANY = browse every event (e.g. leaders auditing).
  // COMPLETE_ANY = "kiosk": complete any station's tasks regardless of roster —
  // for shared station tablet accounts. ADMIN = create/edit templates, services,
  // events + manage rosters + view reports.
  CHECKLISTS_READ_ASSIGNED: "checklists:read:assigned",
  CHECKLISTS_READ_ANY: "checklists:read:any",
  CHECKLISTS_COMPLETE_ANY: "checklists:complete:any",
  CHECKLISTS_ADMIN: "checklists:admin",
} as const;

export type PermissionString = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: readonly PermissionString[] = Object.values(PERMISSIONS) as PermissionString[];
