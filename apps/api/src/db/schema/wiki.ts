import { pgTable, text, timestamp, uuid, boolean, index, primaryKey, type AnyPgColumn } from "drizzle-orm/pg-core";
import { users } from "./users";
import { groups } from "./groups";

/**
 * Wiki (Phase 1.4 MVP; folders added later).
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
 * always the current body+title.
 *
 * Organization: a page nests under at most one of {parentId (another page —
 * a "subpage"), parentFolderId (a wiki_folders row)}, or neither (root).
 * Mutual exclusivity and cycle prevention are enforced in the service, not
 * the DB — same reasoning as parentId below. Folders carry no content or ACL
 * of their own; they're purely organizational, so a page's own visibility/ACL
 * doesn't change based on which folder it sits in.
 */
export const wikiFolders = pgTable(
  "wiki_folders",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    // Tree-shape parent folder. Null = root. ON DELETE SET NULL promotes
    // children (sub-folders and pages alike) to root instead of cascading
    // the whole subtree away — mirrors wiki_pages.parentId below.
    parentFolderId: uuid("parent_folder_id").references(
      (): AnyPgColumn => wikiFolders.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index("wiki_folders_parent_idx").on(t.parentFolderId),
  }),
);

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
    // Tree-shape parent. Null = root page. Cycle prevention is enforced in
    // the service (not the DB) so we can return a 400 instead of a constraint
    // error. ON DELETE SET NULL keeps the children rather than cascading the
    // whole subtree away.
    parentId: uuid("parent_id").references((): AnyPgColumn => wikiPages.id, {
      onDelete: "set null",
    }),
    // Containing folder, mutually exclusive with parentId (see comment above).
    parentFolderId: uuid("parent_folder_id").references(() => wikiFolders.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("wiki_pages_owner_idx").on(t.ownerUserId),
    updatedIdx: index("wiki_pages_updated_idx").on(t.updatedAt),
    parentIdx: index("wiki_pages_parent_idx").on(t.parentId),
    parentFolderIdx: index("wiki_pages_parent_folder_idx").on(t.parentFolderId),
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
  (t) => ({
    pk: primaryKey({ columns: [t.pageId, t.groupId] }),
    // PK leads with pageId; the wiki list + search ACL filter both query by
    // group_id (find pages this user's groups can reach) which would scan
    // without a secondary index.
    groupIdx: index("wiki_page_acl_group_idx").on(t.groupId),
  }),
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
