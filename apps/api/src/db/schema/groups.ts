import { pgTable, text, timestamp, boolean, uuid, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { permissions } from "./roles";

export const groups = pgTable("groups", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  googleGroupId: text("google_group_id").unique(),
  googleGroupEmail: text("google_group_email"),
  isManaged: boolean("is_managed").notNull().default(false),
  // Locally-protected seed groups (admin, user). The API refuses DELETE on
  // these and also refuses edits to the admin group specifically (its name
  // and module access are fixed by code, not the DB).
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const groupMemberships = pgTable(
  "group_memberships",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.groupId, t.userId] }),
    // PK leads with groupId, so userId lookups (called on every authenticated
    // request via loadUserById) would otherwise scan. This is the hottest
    // join in the API.
    userIdx: index("group_memberships_user_idx").on(t.userId),
  }),
);

/**
 * Permissions granted to a group. Each member of the group implicitly holds
 * every permission listed here, in addition to whatever their role(s) grant.
 * The permission loader unions both sources.
 *
 * Only users with USER_ADMIN can edit this table; the admin UI surfaces it at
 * /admin/groups.
 */
export const groupPermissions = pgTable(
  "group_permissions",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.permissionKey] }) })
);

/**
 * Per-group, per-module tier assignment. Replaces group_permissions as the
 * source of truth (group_permissions is left in place but unread; see
 * migration 0024). The auth resolver expands each row into the flat list of
 * permission strings the API enforces via the catalog in
 * packages/shared/src/modules.ts.
 */
export const groupModuleAccess = pgTable(
  "group_module_access",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    moduleKey: text("module_key").notNull(),
    tier: text("tier").notNull(), // 'user' | 'moderator' | 'admin'
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.moduleKey] }) })
);
