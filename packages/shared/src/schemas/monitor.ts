import { z } from "zod";

/**
 * `hls` (a livestream playlist), `hyperdeck` (Blackmagic recorder), `pjlink` (projector / display), `shure` (wireless
 * mic receiver) and `obs` (OBS Studio) are the AV probes (services/monitor/src/av-probes.ts). Any kind may carry
 * `options.schedule` (monitor-schedule.ts): checked only during those hours.
 */
export const MONITOR_KINDS = ["http", "tcp", "icmp", "tls", "dns", "hls", "hyperdeck", "pjlink", "shure", "obs"] as const;
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
 * once it has expired or `warnDays` or fewer days remain before `valid_to`.
 * Only expiry is judged, not whether the chain is trusted (see `probeTls`).
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

/**
 * `options.alerts === false` keeps a monitor quiet: its incidents are still recorded (and it still shows on the status page),
 * but the probe worker sends no down/up/flapping notice and the escalation job never reminds anyone about it. For a check
 * that is only informational, and for test monitors that go down on purpose. Anything else (absent, true) = alerts on.
 */
export function monitorAlertsOff(options: Record<string, unknown> | null | undefined): boolean {
  return options?.alerts === false;
}

/**
 * Monitor options that are credentials: the HTTP probe's Authorization header, the password of a projector (PJLink) or
 * of OBS. They are stored for the probe worker but never returned by the API: the reply carries
 * `MONITOR_SECRET_PLACEHOLDER` instead (the Monitoring USER tier, every volunteer, reads monitors). On an update a
 * placeholder, or a secret key left out, keeps the saved value; an empty string removes it.
 */
export const MONITOR_SECRET_OPTION_KEYS = ["authorization", "password"] as const;
export const MONITOR_SECRET_PLACEHOLDER = "[saved]";

export function redactMonitorOptions(options: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(options ?? {}) };
  for (const k of MONITOR_SECRET_OPTION_KEYS) {
    if (typeof out[k] === "string" && out[k] !== "") out[k] = MONITOR_SECRET_PLACEHOLDER;
  }
  return out;
}

/** The options to store: `incoming`, with each secret the caller did not really change taken from `saved`. */
export function mergeMonitorSecretOptions(
  incoming: Record<string, unknown>,
  saved: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of MONITOR_SECRET_OPTION_KEYS) {
    const v = out[k];
    if (v === MONITOR_SECRET_PLACEHOLDER || v === undefined) {
      if (typeof saved?.[k] === "string" && saved[k] !== "") out[k] = saved[k];
      else delete out[k];
    } else if (v === "") {
      delete out[k];
    }
  }
  return out;
}

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
  /** Set while the monitor keeps going down and up (see alert-rules.ts): its individual notices are held back. */
  flappingSince: z.string().datetime().nullable().optional(),
  /** Listed on the status page that every signed-in person can read. */
  showOnStatus: z.boolean().optional(),
  /** Plain name for that page ("Internet" rather than "Firewall WAN ping"); empty = use the monitor's name. */
  statusName: z.string().nullable().optional(),
  /** The runbook's wiki page id; the page decides who may read its title. */
  runbookPageId: z.string().uuid().nullable().optional(),
  /** The room it is in (docs/assets.md); null = none. */
  locationId: z.string().uuid().nullable().optional(),
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
  showOnStatus: z.boolean().default(false),
  statusName: z.string().trim().max(120).nullable().optional(),
  /** A wiki page with what to do when it fails; null removes the link. */
  runbookPageId: z.string().uuid().nullable().optional(),
  /** The room it is in (docs/assets.md); null = none. */
  locationId: z.string().uuid().nullable().optional(),
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
  /** The build (`BUILD_ID`) the node last reported when it checked in; null if it never did or sent none. */
  version: z.string().nullable().optional(),
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
  /** Somebody has taken it: no more reminders or escalation. */
  acknowledgedAt: z.string().datetime().nullable().optional(),
  acknowledgedBy: z.string().uuid().nullable().optional(),
  /** 0 = nothing sent beyond the first notice, 1 = reminder sent, 2 = second group told. */
  escalationLevel: z.number().int().optional(),
});
export type MonitorIncident = z.infer<typeof monitorIncidentSchema>;
