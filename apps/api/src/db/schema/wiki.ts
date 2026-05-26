import { pgTable, text, timestamp, uuid, boolean, index, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users";
import { groups } from "./groups";

/**
 * Wiki (Phase 1.4 MVP).
 *
 * Visibility:
 *   - 'public' — any signed-in user with wiki:read:own can read
 *   - 'group'  — only members of an entry in wiki_page_acl can read,
 *                plus the owner and anyone with wiki:read:any
 *
 * Edit access:
 *   - the page owner (wiki:write:own)
 *   - members of a wiki_page_acl row with can_edit=true
 *   - holders of wiki:write:any (admin)
 *
 * Every save inserts a row into wiki_revisions; the most-recent revision is
 * always the current body+title. Tree/breadcrumb navigation and attachments
 * land in later phases — keep this schema additive-only.
 */
export const wikiPages = pgTable(
  "wiki_pages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    visibility: text("visibility").notNull().default("public"), // 'public' | 'group'
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("wiki_pages_owner_idx").on(t.ownerUserId),
    updatedIdx: index("wiki_pages_updated_idx").on(t.updatedAt),
  }),
);

export const wikiPageAcl = pgTable(
  "wiki_page_acl",
  {
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    canEdit: boolean("can_edit").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.pageId, t.groupId] }) }),
);

export const wikiRevisions = pgTable(
  "wiki_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    pageId: uuid("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    editorUserId: uuid("editor_user_id").references(() => users.id, { onDelete: "set null" }),
    summary: text("summary"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pageIdx: index("wiki_revisions_page_idx").on(t.pageId, t.createdAt),
  }),
);
