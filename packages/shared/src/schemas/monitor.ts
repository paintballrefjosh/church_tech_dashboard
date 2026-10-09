import { z } from "zod";

export const MONITOR_KINDS = ["http", "tcp", "icmp", "tls", "dns"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const MONITOR_STATUSES = ["up", "down", "unknown"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/**
 * Per-kind options live in a single freeform `options` blob so adding a new
 * dimension (e.g. an "expectedBody" regex for http) doesn't need a migration.
 * The probe worker is the only reader; the UI just passes the object through.
 */
export const monitorHttpOptionsSchema = z.object({
  method: z.enum(["GET", "HEAD", "POST"]).default("GET"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
  /** Optional substring that must appear in the response body. */
  expectBody: z.string().max(500).optional(),
  /** Optional Bearer token / basic-auth header to send unmodified. */
  authorization: z.string().max(500).optional(),
});
export type MonitorHttpOptions = z.infer<typeof monitorHttpOptionsSchema>;

export const monitorTcpOptionsSchema = z.object({
  timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
});
export type MonitorTcpOptions = z.infer<typeof monitorTcpOptionsSchema>;

export const monitorIcmpOptionsSchema = z.object({
  timeoutMs: z.number().int().min(500).max(60_000).default(3_000),
});
export type MonitorIcmpOptions = z.infer<typeof monitorIcmpOptionsSchema>;

/**
 * TLS certificate expiry monitor. `target` is the hostname; the probe opens a
 * TLS connection, reads the leaf certificate, and treats the check as failing
 * once fewer than `warnDays` days remain before `valid_to`.
 */
export const monitorTlsOptionsSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(443),
  warnDays: z.number().int().min(1).max(365).default(21),
  timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
});
export type MonitorTlsOptions = z.infer<typeof monitorTlsOptionsSchema>;

/**
 * DNS resolution monitor. `target` is the name to resolve; the check fails if
 * resolution errors/empties, or (when `expectedValue` is set) if no returned
 * record contains that substring.
 */
export const monitorDnsOptionsSchema = z.object({
  recordType: z.enum(DNS_RECORD_TYPES).default("A"),
  /** Optional substring that must appear in at least one returned record. */
  expectedValue: z.string().max(255).optional(),
  /** Optional resolver IP to query instead of the system default. */
  resolver: z.string().max(64).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
});
export type MonitorDnsOptions = z.infer<typeof monitorDnsOptionsSchema>;

export const monitorSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(200),
  kind: z.enum(MONITOR_KINDS),
  target: z.string().min(1).max(500),
  intervalSec: z.number().int().min(10).max(86_400),
  failThreshold: z.number().int().min(1).max(20),
  recoverThreshold: z.number().int().min(1).max(20),
  options: z.record(z.unknown()),
  enabled: z.boolean(),
  status: z.enum(MONITOR_STATUSES),
  lastCheckedAt: z.string().datetime().nullable(),
  /** NODE_ID of the node whose probe worker made the latest check (multi-node deployments). */
  lastCheckedBy: z.string().nullable().optional(),
  lastLatencyMs: z.number().int().nullable(),
  consecutiveFails: z.number().int(),
  consecutiveOks: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Monitor = z.infer<typeof monitorSchema>;

export const createMonitorSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(MONITOR_KINDS),
  target: z.string().min(1).max(500),
  intervalSec: z.number().int().min(10).max(86_400).default(60),
  failThreshold: z.number().int().min(1).max(20).default(2),
  recoverThreshold: z.number().int().min(1).max(20).default(2),
  options: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;

export const updateMonitorSchema = createMonitorSchema.partial();
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;

export const monitorCheckSchema = z.object({
  id: z.string().uuid(),
  monitorId: z.string().uuid(),
  ok: z.boolean(),
  latencyMs: z.number().int().nullable(),
  info: z.string().nullable(),
  /** NODE_ID of the node that made this check; null for checks recorded before this was tracked. */
  nodeId: z.string().nullable().optional(),
  ts: z.string().datetime(),
});
export type MonitorCheck = z.infer<typeof monitorCheckSchema>;

/** How far back the per-node worker figures look. */
export const MONITOR_WORKER_WINDOW_MIN = 10;

/** One app node's probe worker, as seen from the checks it recorded in the last window. */
export const monitorWorkerSchema = z.object({
  nodeId: z.string(),
  /** The node heartbeats (by the database's clock); false for a node that only appears in old checks. */
  live: z.boolean(),
  checks: z.number().int(),
  failures: z.number().int(),
  avgLatencyMs: z.number().nullable(),
  lastCheckAt: z.string().datetime().nullable(),
});
export type MonitorWorker = z.infer<typeof monitorWorkerSchema>;

export const monitorWorkersSchema = z.object({
  /** More than one app node is registered (or has probed lately): show node details. */
  clustered: z.boolean(),
  windowMin: z.number().int(),
  /** Enabled monitors, so "0 checks" on a node can be read against how much there is to probe. */
  enabledMonitors: z.number().int(),
  nodes: z.array(monitorWorkerSchema),
});
export type MonitorWorkers = z.infer<typeof monitorWorkersSchema>;

export const monitorIncidentSchema = z.object({
  id: z.string().uuid(),
  monitorId: z.string().uuid(),
  startedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
  reason: z.string().nullable(),
});
export type MonitorIncident = z.infer<typeof monitorIncidentSchema>;
