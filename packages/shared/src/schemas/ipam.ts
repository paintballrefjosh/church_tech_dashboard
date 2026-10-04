import { z } from "zod";

/**
 * IPAM — request/response contracts shared by the API and web for the
 * monitoring module's IPAM tab (managed subnets + discovered hosts).
 */

/** IPv4 CIDR (e.g. "10.0.10.0/24"). Prefix bounded to keep a sweep tractable:
 * anything wider than /16 is 65k+ hosts and refused. */
export const cidrSchema = z
  .string()
  .trim()
  .regex(
    /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\/(?:1[6-9]|2\d|3[0-2])$/,
    "Must be an IPv4 CIDR with a /16–/32 prefix, e.g. 10.0.10.0/24",
  );

export const IPAM_SUBNET_SOURCES = ["manual", "cisco", "unifi"] as const;
export type IpamSubnetSource = (typeof IPAM_SUBNET_SOURCES)[number];

/** Read-facing subnet row (list + detail). */
export const ipamSubnetSchema = z.object({
  id: z.string().uuid(),
  cidr: z.string(),
  label: z.string(),
  /** True while the label is still eligible for the periodic sync from the
   * source system's name; false once an operator edits it by hand. */
  labelAuto: z.boolean(),
  vlanId: z.number().int().nullable(),
  gateway: z.string().nullable(),
  source: z.enum(IPAM_SUBNET_SOURCES),
  sourceDetail: z.string().nullable(),
  scanEnabled: z.boolean(),
  /** Named hosts are published to DNS by the DNS sync. */
  dnsSync: z.boolean(),
  lastScanStartedAt: z.string().datetime().nullable(),
  lastScanFinishedAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  /** Distinct hosts ever discovered in this subnet (rows in ipam_hosts). */
  hostCount: z.number().int(),
  /** Hosts currently up. */
  aliveCount: z.number().int(),
  /** Usable IPs implied by the CIDR (e.g. /24 → 254) — the scan denominator. */
  usableHosts: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type IpamSubnet = z.infer<typeof ipamSubnetSchema>;

export const createIpamSubnetSchema = z.object({
  cidr: cidrSchema,
  label: z.string().max(128).optional(),
  vlanId: z.number().int().min(1).max(4094).nullable().optional(),
  gateway: z.string().max(45).nullable().optional(),
  scanEnabled: z.boolean().optional(),
});
export type CreateIpamSubnetInput = z.infer<typeof createIpamSubnetSchema>;

export const updateIpamSubnetSchema = z.object({
  label: z.string().max(128).optional(),
  vlanId: z.number().int().min(1).max(4094).nullable().optional(),
  gateway: z.string().max(45).nullable().optional(),
  scanEnabled: z.boolean().optional(),
  dnsSync: z.boolean().optional(),
});
export type UpdateIpamSubnetInput = z.infer<typeof updateIpamSubnetSchema>;

/** Read-only discovered host (frontend typing; not validated on input). */
export interface IpamHost {
  id: string;
  ipAddress: string;
  macAddress: string | null;
  hostname: string | null;
  netbiosName: string | null;
  unifiName: string | null;
  /** Operator override for the DNS sync's record name. */
  dnsName: string | null;
  isUp: boolean;
  respondedVia: string | null;
  openPorts: number[];
  firstSeenAt: string;
  lastSeenAt: string | null;
  lastScanAt: string | null;
}

/**
 * Host edits. `dnsName` is a single DNS label (letters, digits, hyphens) or
 * null/empty to fall back to the discovered name.
 */
export const updateIpamHostSchema = z.object({
  dnsName: z
    .string()
    .trim()
    .max(63)
    .regex(/^([a-z0-9]([a-z0-9-]*[a-z0-9])?)?$/i, "Use letters, digits and hyphens only (one DNS label)")
    .nullable()
    .optional(),
});
export type UpdateIpamHostInput = z.infer<typeof updateIpamHostSchema>;

/**
 * A candidate range surfaced by discovery (derived from Cisco config/ARP or the
 * UniFi controller) that isn't yet a managed `ipam_subnets` row. The UI offers
 * these as one-click "add & scan" suggestions.
 */
export interface IpamDiscoveredSubnet {
  cidr: string;
  source: IpamSubnetSource;
  sourceDetail: string | null;
  vlanId: number | null;
  gateway: string | null;
  /** Interface name from the source system — the UniFi network's name, or the
   * matching Cisco VLAN's name (`show vlan brief`). Used to pre-fill the
   * managed subnet's label on adopt. */
  label: string | null;
  /** Already a managed subnet (so the UI can show it as added). */
  existing: boolean;
}

/** IPAM tab badge summary. */
export interface IpamSummary {
  enabled: boolean;
  subnets: number;
  scanning: number;
  hosts: number;
  up: number;
  /** Subnets whose last sweep errored — surfaced as the tab's degraded count. */
  errored: number;
}
