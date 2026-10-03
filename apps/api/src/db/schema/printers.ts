import { pgTable, text, timestamp, uuid, integer, boolean, jsonb } from "drizzle-orm/pg-core";

/**
 * Printer inventory + last-poll snapshot. The polling worker (in
 * PrintersService) overwrites the `last*` columns and JSONB payloads on each
 * tick; the frontend reads them directly so the list page is one query.
 *
 * Per-printer SNMP credentials are nullable — null means "use the
 * `printers.default_*` settings". The same goes for the Fiery fields (only
 * relevant when `kind = 'fiery'`).
 */
export const printers = pgTable("printers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  /** 'ricoh' | 'fiery'. */
  kind: text("kind").notNull(),
  snmpPort: integer("snmp_port").notNull().default(161),
  /** 'v1' | 'v2c'. Null falls back to printers.default_snmp_version. */
  snmpVersion: text("snmp_version"),
  /** Null falls back to printers.default_snmp_community. */
  snmpCommunity: text("snmp_community"),
  /** Fiery REST API base URL (e.g. https://fiery.local). */
  fieryApiUrl: text("fiery_api_url"),
  fieryApiKey: text("fiery_api_key"),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  /** 'green' | 'yellow' | 'red' | 'unknown' */
  lastStatus: text("last_status").notNull().default("unknown"),
  lastCheckedAt: timestamp("last_checked_at"),
  lastError: text("last_error"),
  /** [{name, colorant, level, max, percent}] */
  supplies: jsonb("supplies").notNull().default([]),
  /** [{name, level, max, percent}] */
  inputs: jsonb("inputs").notNull().default([]),
  /** [{severity, description}] */
  alerts: jsonb("alerts").notNull().default([]),
  fieryQueueDepth: integer("fiery_queue_depth"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
