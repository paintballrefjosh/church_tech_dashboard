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

/** Record types the dashboard can create/edit/delete. Others are read-only here. */
export const DNS_EDITABLE_TYPES = ["A", "AAAA", "CNAME", "PTR", "MX", "TXT", "SRV"] as const;
export type DnsEditableType = (typeof DNS_EDITABLE_TYPES)[number];

/**
 * Comment stamped on records the IPAM sync owns (phase 3). Records carrying it
 * can't be edited by hand through the dashboard, and hand-made records may not
 * claim it.
 */
export const DNS_MANAGED_MARKER = "managed-by:church-dashboard";

// A domain name (absolute or relative, optional trailing dot, `_` allowed for
// SRV/DKIM-style labels, optional leading `*.` wildcard).
const DOMAIN_RE =
  /^(\*\.)?([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.?$/i;
const domainName = z.string().trim().min(1).max(253).regex(DOMAIN_RE, "Invalid domain name");
const u16 = z.number().int().min(0).max(65535);

/** Structured rData per editable type — mirrors Technitium's API field names. */
export const dnsRecordDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("A"), ipAddress: z.string().trim().ip({ version: "v4", message: "Invalid IPv4 address" }) }),
  z.object({ type: z.literal("AAAA"), ipAddress: z.string().trim().ip({ version: "v6", message: "Invalid IPv6 address" }) }),
  z.object({ type: z.literal("CNAME"), cname: domainName }),
  z.object({ type: z.literal("PTR"), ptrName: domainName }),
  z.object({ type: z.literal("MX"), preference: u16, exchange: domainName }),
  z.object({
    type: z.literal("TXT"),
    text: z.string().min(1).max(4000),
    /** Technitium's "split on newlines into character-strings" flag. */
    splitText: z.boolean().default(false),
  }),
  z.object({ type: z.literal("SRV"), priority: u16, weight: u16, port: u16, target: domainName }),
]);
export type DnsRecordData = z.infer<typeof dnsRecordDataSchema>;

export const dnsRecordSchema = z.object({
  name: z.string(),
  type: z.string(),
  ttl: z.number().int(),
  /** rData rendered to one display string (e.g. "10 mail.example.org" for MX). */
  value: z.string(),
  disabled: z.boolean(),
  comments: z.string().nullable(),
  /** Structured rData for editable types; null for read-only types (SOA, NS, …). */
  data: dnsRecordDataSchema.nullable(),
  /** Owned by the IPAM sync (comment carries DNS_MANAGED_MARKER). */
  managed: z.boolean(),
});
export type DnsRecord = z.infer<typeof dnsRecordSchema>;

/**
 * A record name as typed in the form: "@" (zone apex), a relative name
 * ("printer", "_sip._tcp"), or a fully qualified one inside the zone.
 */
const recordName = z
  .string()
  .trim()
  .max(253)
  .refine((v) => v === "" || v === "@" || DOMAIN_RE.test(v), "Invalid record name");

const recordComments = z
  .string()
  .max(500)
  .refine((v) => !v.includes(DNS_MANAGED_MARKER), "That comment is reserved for synced records");

const recordTtl = z.number().int().min(0).max(604_800);

export const dnsRecordCreateSchema = z.object({
  name: recordName,
  /** Omitted = Technitium's default TTL. */
  ttl: recordTtl.optional(),
  comments: recordComments.default(""),
  data: dnsRecordDataSchema,
});
export type DnsRecordCreateInput = z.infer<typeof dnsRecordCreateSchema>;

/**
 * Edit = identify the record by its current name + data (Technitium records
 * have no id), then the new values. The type can't change: delete and re-add.
 */
export const dnsRecordUpdateSchema = z
  .object({
    current: z.object({ name: recordName, data: dnsRecordDataSchema }),
    name: recordName,
    ttl: recordTtl,
    comments: recordComments.default(""),
    data: dnsRecordDataSchema,
  })
  .refine((v) => v.current.data.type === v.data.type, {
    message: "Record type can't change; delete the record and add a new one",
    path: ["data", "type"],
  });
export type DnsRecordUpdateInput = z.infer<typeof dnsRecordUpdateSchema>;

export const dnsRecordDeleteSchema = z.object({ name: recordName, data: dnsRecordDataSchema });
export type DnsRecordDeleteInput = z.infer<typeof dnsRecordDeleteSchema>;

/** Response of every record write; the audit log stores it as the "after" snapshot. */
export interface DnsRecordWriteResult {
  /** `<zone>/<fqdn>/<type>` — audit resource id. */
  id: string;
  zone: string;
  before: DnsRecord | null;
  after: DnsRecord | null;
}

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
