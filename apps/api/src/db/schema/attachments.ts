import { pgTable, text, timestamp, uuid, bigint, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Generic attachments table — one row per uploaded file, owned by any parent
 * resource via (parent_type, parent_id). Each consuming module (notes,
 * tickets, wiki, ...) does its own auth check against the parent before
 * touching attachments — the storage layer itself stays generic.
 *
 * No FK to a parent table on purpose: a single FK would only be possible if
 * we enforced one parent type. The parent's module is responsible for
 * cascade-deleting its attachment rows (and the underlying MinIO objects)
 * when the parent goes away.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    parentType: text("parent_type").notNull(), // 'note' | 'ticket' | 'wiki_page' | ...
    parentId: uuid("parent_id").notNull(),
    uploaderUserId: uuid("uploader_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    filename: text("filename").notNull(), // original filename from the browser
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    storageKey: text("storage_key").notNull().unique(), // MinIO object key
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    parentIdx: index("attachments_parent_idx").on(t.parentType, t.parentId),
    uploaderIdx: index("attachments_uploader_idx").on(t.uploaderUserId),
  }),
);
