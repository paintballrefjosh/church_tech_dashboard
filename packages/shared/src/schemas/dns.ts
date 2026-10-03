import { z } from "zod";

/**
 * DNS — the monitoring module's DNS tab, a client for a Technitium DNS Server
 * (v14+ cluster or a single node). The dashboard talks only to the configured
 * primary's HTTP API; records live in Technitium, not in this database.
 */

/** Technitium's stats windows (`dashboard/stats/get?type=`). */
export const DNS_STATS_RANGES = ["LastHour", "LastDay", "LastWeek", "LastMonth"] as const;
export type DnsStatsRange = (typeof DNS_STATS_RANGES)[number];

/** One cluster member as reported by `admin/cluster/state`. */
export const dnsNodeSchema = z.object({
  name: z.string(),
  url: z.string().nullable(),
  ipAddress: z.string().nullable(),
  /** "Primary" | "Secondary" as Technitium reports it. */
  type: z.string(),
  /** "Self" | "Connected" | "Unreachable" | … as Technitium reports it. */
  state: z.string(),
  version: z.string().nullable(),
  lastSeen: z.string().nullable(),
});
export type DnsNode = z.infer<typeof dnsNodeSchema>;

export const dnsSummarySchema = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  error: z.string().nullable(),
  /** Technitium version of the node we talk to. */
  version: z.string().nullable(),
  /** Domain name of the node we talk to. */
  server: z.string().nullable(),
  clustered: z.boolean(),
  /**
   * Cluster members, or null when the cluster isn't initialised or the API
   * token lacks Administration: View (the node list needs it).
   */
  nodes: z.array(dnsNodeSchema).nullable(),
  /** Non-internal authoritative zones. */
  zoneCount: z.number().int(),
  /** Cluster members not in a Self/Connected state. */
  unreachableNodes: z.number().int(),
});
export type DnsSummary = z.infer<typeof dnsSummarySchema>;

export const dnsZoneSchema = z.object({
  name: z.string(),
  /** Primary | Secondary | Stub | Forwarder | Catalog | … */
  type: z.string(),
  disabled: z.boolean(),
  dnssecStatus: z.string().nullable(),
  soaSerial: z.number().nullable(),
  lastModified: z.string().nullable(),
  /** Secondary zones: the last zone transfer failed. */
  syncFailed: z.boolean(),
  /** Primary zones: NOTIFY to a secondary failed. */
  notifyFailed: z.boolean(),
  isExpired: z.boolean(),
});
export type DnsZone = z.infer<typeof dnsZoneSchema>;

export const dnsRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  ttl: z.number().int(),
  /** rData rendered to one display string (e.g. "10 mail.example.org" for MX). */
  value: z.string(),
  disabled: z.boolean(),
  comments: z.string().nullable(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

export const dnsTopEntrySchema = z.object({
  name: z.string(),
  /** Reverse-lookup name for a client IP, when Technitium has one. */
  domain: z.string().nullable(),
  hits: z.number().int(),
});
export type DnsTopEntry = z.infer<typeof dnsTopEntrySchema>;

export const dnsStatsSchema = z.object({
  range: z.enum(DNS_STATS_RANGES),
  /** True when the figures are the whole cluster's (`node=cluster`). */
  cluster: z.boolean(),
  totals: z.object({
    queries: z.number().int(),
    noError: z.number().int(),
    serverFailure: z.number().int(),
    nxDomain: z.number().int(),
    refused: z.number().int(),
    authoritative: z.number().int(),
    recursive: z.number().int(),
    cached: z.number().int(),
    blocked: z.number().int(),
    dropped: z.number().int(),
    clients: z.number().int(),
  }),
  topClients: z.array(dnsTopEntrySchema),
  topDomains: z.array(dnsTopEntrySchema),
  topBlockedDomains: z.array(dnsTopEntrySchema),
});
export type DnsStats = z.infer<typeof dnsStatsSchema>;

/**
 * "Test connection" body. Every field is optional: anything left out falls
 * back to the saved settings, so a half-edited settings form still gets a
 * realistic test (an empty token means "unchanged").
 */
export const dnsTestSchema = z.object({
  baseUrl: z.string().max(512).optional(),
  apiToken: z.string().max(512).optional(),
  verifyTls: z.boolean().optional(),
});
export type DnsTestInput = z.infer<typeof dnsTestSchema>;
