import { pgTable, text, timestamp, uuid, index, primaryKey } from "drizzle-orm/pg-core";
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

/**
 * Per-user per-kind delivery preferences. `channels` is the set of channels
 * the user wants to be notified through for that kind — "in_app", "email",
 * both, or neither. Rows are upserted by /me/notification-prefs; a missing
 * row means "use the global default" (in_app + email).
 *
 * Replaces the older `users.muted_notification_kinds` array column, which
 * is left in place so the rolling upgrade still works (NotificationsService
 * unions both sources during the migration window).
 */
export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    channels: text("channels").array().notNull().default([]),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.kind] }),
  }),
);
