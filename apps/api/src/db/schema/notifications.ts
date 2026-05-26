import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Generic per-user notifications (Phase 1.7). `kind` identifies the event type
 * for filtering / future per-kind preferences (e.g. "ticket.assigned",
 * "ticket.status", "ticket.comment"). `link` is a relative URL the bell drops
 * the user onto when they click — keeping it as text avoids a polymorphic FK.
 *
 * read_at is nullable: NULL = unread. Setting it marks read; we never delete
 * read rows automatically — operators can prune via a future scheduled job.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    readAt: timestamp("read_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    recipientIdx: index("notifications_recipient_idx").on(t.recipientUserId, t.createdAt),
    unreadIdx: index("notifications_unread_idx").on(t.recipientUserId, t.readAt),
  }),
);
