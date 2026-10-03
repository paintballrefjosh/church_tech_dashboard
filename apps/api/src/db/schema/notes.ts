import { pgTable, text, timestamp, boolean, uuid, integer, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Google Keep-style notes. Phase 1.1 is owner-only — sharing/collaborators
 * land in a later phase. `archived` is a soft-archive flag (shows in trash);
 * `deleted_at` would be added in 1.2 if we want a soft-delete tier.
 */
export const notes = pgTable(
  "notes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    body: text("body").notNull().default(""),
    color: text("color").notNull().default("default"),
    pinned: boolean("pinned").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    // Per-user grid placement. Nullable so newly-created notes flow into the
    // first open slot until the user actually moves them.
    gridX: integer("grid_x"),
    gridY: integer("grid_y"),
    gridW: integer("grid_w"),
    gridH: integer("grid_h"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("notes_owner_idx").on(t.ownerUserId),
    updatedIdx: index("notes_updated_idx").on(t.updatedAt),
    // Note list always filters by owner + archived flag then sorts by
    // recency. The composite covers all three predicates without a sort.
    ownerArchivedUpdatedIdx: index("notes_owner_archived_updated_idx").on(
      t.ownerUserId,
      t.archived,
      t.updatedAt.desc(),
    ),
  })
);
