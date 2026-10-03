import { pgTable, text, timestamp, uuid, integer, boolean, real } from "drizzle-orm/pg-core";

/**
 * UPS inventory + last-poll snapshot, polled over SNMP (UPS-MIB / RFC 1628).
 * Same shape as `printers`: the polling worker (UpsService) overwrites the
 * `last*` columns and the snapshot fields on each tick, so the list page is one
 * query.
 *
 * Per-UPS SNMP credentials are nullable — null means "use the
 * `monitoring.ups_default_*` settings".
 */
export const upsDevices = pgTable("ups_devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  snmpPort: integer("snmp_port").notNull().default(161),
  /** 'v1' | 'v2c'. Null falls back to monitoring.ups_default_snmp_version. */
  snmpVersion: text("snmp_version"),
  /** Null falls back to monitoring.ups_default_snmp_community. */
  snmpCommunity: text("snmp_community"),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  /** 'green' | 'yellow' | 'red' | 'unknown' */
  lastStatus: text("last_status").notNull().default("unknown"),
  lastCheckedAt: timestamp("last_checked_at"),
  lastError: text("last_error"),
  // Last-poll snapshot.
  batteryPct: integer("battery_pct"),
  runtimeMin: integer("runtime_min"),
  loadPct: integer("load_pct"),
  inputVoltage: real("input_voltage"),
  outputVoltage: real("output_voltage"),
  /** 'unknown' | 'normal' | 'low' | 'depleted' (UPS-MIB upsBatteryStatus). */
  batteryState: text("battery_state").notNull().default("unknown"),
  /** 'unknown' | 'normal' | 'battery' | 'bypass' | 'other' (upsOutputSource). */
  outputSource: text("output_source").notNull().default("unknown"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
