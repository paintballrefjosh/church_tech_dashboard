import { pgTable, text, timestamp, uuid, index, primaryKey, boolean, integer } from "drizzle-orm/pg-core";
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

/**
 * Per-user delivery choices: quiet hours, a once-a-day email summary, and whether urgent alerts ignore both. Times are minutes
 * after midnight on the SITE's clock (`site.timezone`). A missing row means the defaults (everything immediate), so older code
 * and new accounts need nothing. Rules: packages/shared/src/notification-delivery.ts.
 */
export const notificationDelivery = pgTable("notification_delivery", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  quietEnabled: boolean("quiet_enabled").notNull().default(false),
  quietStart: integer("quiet_start").notNull().default(1320),
  quietEnd: integer("quiet_end").notNull().default(420),
  digestEnabled: boolean("digest_enabled").notNull().default(false),
  digestAt: integer("digest_at").notNull().default(480),
  urgentThrough: boolean("urgent_through").notNull().default(true),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Email that is waiting for the person's quiet hours to end or their daily summary time. It holds what the email will say, not
 * a release time: when it may go out is worked out from the person's CURRENT choices (`emailReleaseAt`), so changing them
 * applies to what is already waiting. Rows are deleted when released (the `notification-release` job), so this is a queue, not
 * history, and is not part of a backup.
 */
export const notificationHeld = pgTable(
  "notification_held",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    ticketNumber: integer("ticket_number"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    recipientIdx: index("notification_held_recipient_idx").on(t.recipientUserId, t.createdAt),
  }),
);

/**
 * A browser a person turned push notifications on in (Web Push). `endpoint` is the push service's address for that browser
 * and `p256dh`/`auth` are its keys for encrypting what we send. A device the push service says is gone (404/410) is deleted.
 * These are device credentials, so they are not part of a backup: after a restore people turn push on again.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastSentAt: timestamp("last_sent_at"),
    lastError: text("last_error"),
  },
  (t) => ({
    userIdx: index("push_subscriptions_user_idx").on(t.userId),
  }),
);
