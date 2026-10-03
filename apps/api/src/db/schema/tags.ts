import { pgTable, text, timestamp, uuid, index, primaryKey } from "drizzle-orm/pg-core";

/**
 * A user-defined tag. Names are unique (case-insensitive) so "Worship" and
 * "worship" collapse to one row — keeps tag lists tidy on the UI.
 *
 * Color is one of a fixed palette (see TAG_COLORS in @church/shared) so we
 * never end up with a sea of subtly-different greys.
 */
export const tags = pgTable(
  "tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull().unique(),
    color: text("color").notNull().default("slate"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index("tags_name_idx").on(t.name),
  }),
);

/**
 * Polymorphic many-to-many: a tag is attached to (resource_type, resource_id).
 * resource_type is one of "ticket" | "note" | "wiki_page". We don't bother
 * with FK constraints to each resource table because the resource_id isn't
 * declared as a polymorphic FK in Postgres; instead each resource service
 * deletes its own assignments on resource delete.
 */
export const tagAssignments = pgTable(
  "tag_assignments",
  {
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tagId, t.resourceType, t.resourceId] }),
    resourceIdx: index("tag_assignments_resource_idx").on(t.resourceType, t.resourceId),
  }),
);
