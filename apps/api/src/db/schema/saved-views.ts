import { pgTable, text, timestamp, uuid, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user saved combinations of list-page filters. Today the list pages
 * (tickets, wiki, notes) accept a rich set of query params; this table just
 * persists named combinations so users can flip between "my open priority>=high"
 * and "unassigned this week" with one click.
 *
 * `query` stores the URL-style query params as a flat key/value object. The
 * shape mirrors what the page already uses, so saving = capture-current and
 * applying = push-onto-URL. No new validation surface.
 */
export const savedViews = pgTable(
  "saved_views",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // 'ticket' | 'wiki_page' | 'note' — matches the existing resource_type
    // shape used in tags/search/activity for consistency.
    resourceType: text("resource_type").notNull(),
    name: text("name").notNull(),
    query: jsonb("query").notNull().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    userTypeIdx: index("saved_views_user_type_idx").on(t.userId, t.resourceType),
  }),
);
