import { pgTable, text, integer, timestamp, uuid, jsonb } from "drizzle-orm/pg-core";
import { attachments } from "./attachments";

/**
 * Switch models for the "switch view" (see packages/shared/src/schemas/switch-model.ts): a name, the model strings it
 * matches, a front and a back picture (rows of `attachments`, parent type `switch_model`), which side has the ports,
 * and a box per port as a fraction of that picture. Pictures are cleared (not the model deleted) if their attachment
 * goes, so a restore of one section without the other leaves a model that simply has no picture yet.
 */
export const switchModels = pgTable("switch_models", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  match: jsonb("match").notNull().default([]),
  portSide: text("port_side").notNull().default("front"),
  frontImageId: uuid("front_image_id").references(() => attachments.id, { onDelete: "set null" }),
  backImageId: uuid("back_image_id").references(() => attachments.id, { onDelete: "set null" }),
  frontWidth: integer("front_width"),
  frontHeight: integer("front_height"),
  backWidth: integer("back_width"),
  backHeight: integer("back_height"),
  ports: jsonb("ports").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
