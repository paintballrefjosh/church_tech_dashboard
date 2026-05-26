import { pgTable, text, timestamp, boolean, uuid, index } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    ownerIdx: index("notes_owner_idx").on(t.ownerUserId),
    updatedIdx: index("notes_updated_idx").on(t.updatedAt),
  })
);
