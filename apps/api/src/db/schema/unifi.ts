import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

/**
 * Operator acknowledgements of offline UniFi devices, keyed by device MAC.
 *
 * An ack suppresses a currently-offline device from the Network (UniFi) tab's
 * problem badge. It is valid only for the CURRENT offline episode: the service
 * deletes the ack the moment the device is next observed online, so if it later
 * goes offline again that is a fresh, un-acked episode which counts (and alerts)
 * again. There is no history kept here — at most one row per still-acked device.
 */
export const unifiDeviceAcks = pgTable("unifi_device_acks", {
  mac: text("mac").primaryKey(),
  // Snapshot of the device's display name at ack time, so the acked list still
  // reads sensibly even if the controller later drops the device.
  deviceName: text("device_name").notNull().default(""),
  ackedAt: timestamp("acked_at").notNull().defaultNow(),
  // Null if the acking user is later hard-deleted.
  ackedByUserId: uuid("acked_by_user_id").references(() => users.id, { onDelete: "set null" }),
});
