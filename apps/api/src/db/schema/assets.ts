import { sql } from "drizzle-orm";
import { pgTable, text, boolean, timestamp, uuid, real, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Rooms (`locations`) and the asset inventory (docs/assets.md). A room is pointed at by tickets, assets, cabinets,
 * monitors, infra hosts and printers through their `location_id` (ON DELETE SET NULL). Dates on assets are date-only
 * strings on the site's calendar, as renewals.
 */
export const locations = pgTable("locations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  building: text("building").notNull().default(""),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tag: text("tag").notNull().unique(),
    name: text("name").notNull(),
    category: text("category").notNull().default("other"),
    make: text("make").notNull().default(""),
    model: text("model").notNull().default(""),
    serial: text("serial").notNull().default(""),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    status: text("status").notNull().default("in_service"),
    lendable: boolean("lendable").notNull().default(true),
    purchasedOn: text("purchased_on"),
    cost: real("cost"),
    warrantyUntil: text("warranty_until"),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ locationIdx: index("assets_location_idx").on(t.locationId) }),
);

/**
 * Who has an item. At most one open row (`returned_at IS NULL`) per asset: the partial unique index is the rule, so two
 * people checking the same item out at once cannot both succeed. `reminded_for` is the due date the overdue notice was sent
 * for (the `asset-overdue` job claims it with a conditional UPDATE).
 */
export const assetCheckouts = pgTable(
  "asset_checkouts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    holderUserId: uuid("holder_user_id").references(() => users.id, { onDelete: "set null" }),
    holderName: text("holder_name").notNull(),
    outByUserId: uuid("out_by_user_id").references(() => users.id, { onDelete: "set null" }),
    outAt: timestamp("out_at").notNull().defaultNow(),
    dueOn: text("due_on"),
    returnedAt: timestamp("returned_at"),
    returnedByUserId: uuid("returned_by_user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note").notNull().default(""),
    returnNote: text("return_note").notNull().default(""),
    remindedFor: text("reminded_for"),
  },
  (t) => ({
    openIdx: uniqueIndex("asset_checkouts_open_idx").on(t.assetId).where(sql`returned_at IS NULL`),
    assetIdx: index("asset_checkouts_asset_idx").on(t.assetId, t.outAt),
    holderIdx: index("asset_checkouts_holder_idx").on(t.holderUserId),
  }),
);
