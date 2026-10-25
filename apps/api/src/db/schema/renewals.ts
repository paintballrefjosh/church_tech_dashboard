import { pgTable, text, boolean, timestamp, uuid, real, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Renewals (packages/shared/src/schemas/renewal.ts). `renews_on` is a date-only string on the site's calendar
 * (YYYY-MM-DD): a calendar date, not an instant, so no time zone can move it. `reminded_for` is the marker of the last
 * reminder sent (`renewalReminderDue`); the `renewal-reminders` job claims a reminder by a conditional UPDATE on it.
 */
export const renewals = pgTable(
  "renewals",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    category: text("category").notNull().default("licence"),
    vendor: text("vendor").notNull().default(""),
    renewsOn: text("renews_on").notNull(),
    cost: real("cost"),
    autoRenew: boolean("auto_renew").notNull().default(false),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    // Days before renewsOn that a reminder goes out (jsonb: the backup codec writes back jsonb, not integer[]).
    remindDays: jsonb("remind_days").$type<number[]>().notNull().default([30, 7]),
    remindedFor: text("reminded_for"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ renewsIdx: index("renewals_renews_on_idx").on(t.renewsOn) }),
);
