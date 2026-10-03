import { z } from "zod";

export const PRINTER_KINDS = ["ricoh", "fiery"] as const;
export type PrinterKind = (typeof PRINTER_KINDS)[number];

export const PRINTER_STATUSES = ["green", "yellow", "red", "unknown"] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const SNMP_VERSIONS = ["v1", "v2c"] as const;
export type SnmpVersion = (typeof SNMP_VERSIONS)[number];

export const COLORANTS = [
  "cyan",
  "magenta",
  "yellow",
  "black",
  "other",
] as const;
export type Colorant = (typeof COLORANTS)[number];

export const printerSupplySchema = z.object({
  name: z.string(),
  colorant: z.enum(COLORANTS),
  level: z.number().int(),
  max: z.number().int(),
  percent: z.number().int().min(0).max(100),
});
export type PrinterSupply = z.infer<typeof printerSupplySchema>;

export const printerInputSchema = z.object({
  name: z.string(),
  level: z.number().int(),
  max: z.number().int(),
  percent: z.number().int().min(0).max(100),
});
export type PrinterInput = z.infer<typeof printerInputSchema>;

export const printerAlertSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  description: z.string(),
});
export type PrinterAlert = z.infer<typeof printerAlertSchema>;

export const printerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  host: z.string(),
  kind: z.enum(PRINTER_KINDS),
  snmpPort: z.number().int(),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable(),
  snmpCommunity: z.string().nullable(),
  fieryApiUrl: z.string().nullable(),
  fieryApiKey: z.string().nullable(),
  enabled: z.boolean(),
  notes: z.string().nullable(),
  lastStatus: z.enum(PRINTER_STATUSES),
  lastCheckedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  supplies: z.array(printerSupplySchema),
  inputs: z.array(printerInputSchema),
  alerts: z.array(printerAlertSchema),
  fieryQueueDepth: z.number().int().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Printer = z.infer<typeof printerSchema>;

export const createPrinterSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  kind: z.enum(PRINTER_KINDS),
  snmpPort: z.number().int().min(1).max(65535).default(161),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable().default(null),
  snmpCommunity: z.string().trim().max(64).nullable().default(null),
  fieryApiUrl: z.string().trim().max(500).nullable().default(null),
  fieryApiKey: z.string().trim().max(500).nullable().default(null),
  notes: z.string().max(500).nullable().default(null),
});
export type CreatePrinterInput = z.infer<typeof createPrinterSchema>;

export const updatePrinterSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(255).optional(),
  kind: z.enum(PRINTER_KINDS).optional(),
  snmpPort: z.number().int().min(1).max(65535).optional(),
  snmpVersion: z.enum(SNMP_VERSIONS).nullable().optional(),
  snmpCommunity: z.string().trim().max(64).nullable().optional(),
  fieryApiUrl: z.string().trim().max(500).nullable().optional(),
  fieryApiKey: z.string().trim().max(500).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type UpdatePrinterInput = z.infer<typeof updatePrinterSchema>;

export const printerSummarySchema = z.object({
  green: z.number().int(),
  yellow: z.number().int(),
  red: z.number().int(),
  unknown: z.number().int(),
  total: z.number().int(),
});
export type PrinterSummary = z.infer<typeof printerSummarySchema>;
