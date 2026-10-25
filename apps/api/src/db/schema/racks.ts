import { pgTable, text, integer, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { switchModels } from "./switch-models";

/**
 * Cabinets (racks) and the items placed in them (see packages/shared/src/schemas/rack.ts). An item points at a Cisco
 * switch, an infrastructure host or a UniFi device by `source_kind` + `source_id` (no foreign key: a UniFi device is a
 * MAC the controller reports, and a device deleted elsewhere must not silently empty a place in the cabinet), or is a
 * custom thing. `label`, `hostname` and `ip` are what was known when it was placed and are shown only when the device
 * cannot be read. Overlap is checked by the service (SQL cannot express "ranges of U do not intersect" portably).
 */
export const racks = pgTable("racks", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  location: text("location").notNull().default(""),
  units: integer("units").notNull().default(42),
  notes: text("notes").notNull().default(""),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const rackItems = pgTable(
  "rack_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rackId: uuid("rack_id")
      .notNull()
      .references(() => racks.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull(), // "cisco" | "infra" | "unifi" | "custom"
    sourceId: text("source_id"),
    label: text("label").notNull().default(""),
    hostname: text("hostname"),
    ip: text("ip"),
    style: text("style").notNull().default("other"),
    startU: integer("start_u").notNull(),
    heightU: integer("height_u").notNull().default(1),
    modelId: uuid("model_id").references(() => switchModels.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({ rackIdx: index("rack_items_rack_idx").on(t.rackId) }),
);
