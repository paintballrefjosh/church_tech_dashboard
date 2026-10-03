import { pgTable, text, timestamp, uuid, index, primaryKey } from "drizzle-orm/pg-core";
import { tickets } from "./tickets";

/**
 * Admin-curated category catalogue for tickets. Distinct from tags: categories
 * are only meaningful on tickets and only admins/support staff can shape the
 * list. Name is unique so the picker never shows two identical options.
 */
export const ticketCategories = pgTable(
  "ticket_categories",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    color: text("color").notNull().default("slate"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("ticket_categories_name_idx").on(t.name),
  }),
);

/**
 * Many-to-many: a ticket can have N categories assigned. Cascades both ways so
 * deleting a ticket or a category drops the assignment cleanly.
 */
export const ticketCategoryAssignments = pgTable(
  "ticket_category_assignments",
  {
    ticketId: uuid("ticket_id")
      .notNull()
      .references(() => tickets.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => ticketCategories.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticketId, t.categoryId] }),
    ticketIdx: index("ticket_category_assignments_ticket_idx").on(t.ticketId),
  }),
);
