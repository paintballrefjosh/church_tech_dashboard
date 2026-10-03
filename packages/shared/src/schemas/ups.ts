import { z } from "zod";

import { SNMP_VERSIONS } from "./printer";

export const UPS_STATUSES = ["green", "yellow", "red", "unknown"] as const;
export type UpsStatus = (typeof UPS_STATUSES)[number];

/**
 * Battery status as reported by UPS-MIB (RFC 1628) `upsBatteryStatus`:
 * 1 unknown, 2 normal, 3 low, 4 depleted. We keep the string form for the UI.
 */
export const UPS_BATTERY_STATES = [
  "unknown",
  "normal",
  "low",
  "depleted",
] as const;
export type UpsBatteryState = (typeof UPS_BATTERY_STATES)[number];

/**
 * Power source as reported by `upsOutputSource`: normal (on-line), battery,
 * bypass, booster/reducer, etc. Collapsed to the states we act on.
 */
export const UPS_OUTPUT_SOURCES = [
  "unknown",
  "normal",
  "battery",
  "bypass",
  "other",
] as const;
export type UpsOutputSource = (typeof UPS_OUTPUT_SOURCES)[number];

export const upsSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  snmpPort: z.number().int(),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable(),
  snmpCommunity: z.string().nullable(),
  enabled: z.boolean(),
  notes: z.string().nullable(),
  lastStatus: z.enum(UPS_STATUSES),
  lastCheckedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  // Last-poll snapshot.
  batteryPct: z.number().int().nullable(),
  runtimeMin: z.number().int().nullable(),
  loadPct: z.number().int().nullable(),
  inputVoltage: z.number().nullable(),
  outputVoltage: z.number().nullable(),
  batteryState: z.enum(UPS_BATTERY_STATES),
  outputSource: z.enum(UPS_OUTPUT_SOURCES),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Ups = z.infer<typeof upsSchema>;

export const createUpsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  snmpPort: z.number().int().min(1).max(65535).default(161),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable().default(null),
  snmpCommunity: z.string().trim().max(64).nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
});
export type CreateUpsInput = z.infer<typeof createUpsSchema>;

export const updateUpsSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  snmpPort: z.number().int().min(1).max(65535).optional(),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable().optional(),
  snmpCommunity: z.string().trim().max(64).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdateUpsInput = z.infer<typeof updateUpsSchema>;

export const upsSummarySchema = z.object({
  green: z.number().int(),
  yellow: z.number().int(),
  red: z.number().int(),
  unknown: z.number().int(),
  total: z.number().int(),
});
export type UpsSummary = z.infer<typeof upsSummarySchema>;
