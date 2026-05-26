import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Per-user dashboard layout (Phase 1.6). One row per user — the user is the
 * primary key, so saves are upserts. The layout JSON is an array of placement
 * records that react-grid-layout consumes directly:
 *
 *   [{ tileId: "tickets.summary", x: 0, y: 0, w: 4, h: 3 }, ...]
 *
 * tileId values must match an entry in the TILE_CATALOGUE constant in
 * packages/shared. Unknown ids are ignored by the renderer (forward
 * compatible: removing a tile from the catalogue doesn't break old layouts).
 */
export const dashboardLayouts = pgTable("dashboard_layouts", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  layout: jsonb("layout").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
