import { pgTable, text, boolean, integer, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";

/**
 * Alert channels (see packages/shared/src/schemas/alert-channel.ts): site-wide places monitoring alerts are also sent
 * to. `config` holds the type's non-secret settings; `secret` is the token or webhook address, encrypted like a secret
 * setting (`enc:v1:`), never returned by the API.
 */
export const alertChannels = pgTable("alert_channels", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  events: text("events").notNull().default("outages"),
  config: jsonb("config").notNull().default({}),
  secret: text("secret"),
  lastSentAt: timestamp("last_sent_at"),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * Alerts waiting to go out, written by whoever raises them and sent by the API's `alert-dispatch` cluster job.
 * `fanout` rows come from the probe worker (which cannot import the API): the job also tells the people (bell, email,
 * push, through NotificationsService) as well as the channels. Other rows were already given to people by the API and
 * only go to the channels. Claimed with `claimed_until` (any node may run the job after a handover); kept a week after
 * sending, then pruned by the same job.
 */
export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    link: text("link"),
    fanout: boolean("fanout").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    claimedUntil: timestamp("claimed_until"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at"),
    lastError: text("last_error"),
  },
  (t) => ({ pendingIdx: index("alert_outbox_pending_idx").on(t.sentAt, t.createdAt) }),
);
