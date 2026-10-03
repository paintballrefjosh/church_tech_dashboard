import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * One-to-one link between a local user and a Planning Center person. Stored
 * locally so the dashboard tile + position rows can resolve PC team members
 * back to our own users (for avatar, profile link, mentions, etc.) without
 * hammering PC every render.
 *
 * Both columns are unique: a local user has at most one PC person, and a PC
 * person maps to at most one local user. The denormalised name/email lets us
 * keep the UI useful even if PC is temporarily unreachable.
 */
export const planningCenterLinks = pgTable(
  "planning_center_links",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    pcPersonId: text("pc_person_id").notNull().unique(),
    pcEmail: text("pc_email"),
    pcFirstName: text("pc_first_name"),
    pcLastName: text("pc_last_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    pcPersonIdx: index("planning_center_links_pc_person_idx").on(t.pcPersonId),
  }),
);
