import { z } from "zod";

/**
 * Cisco switch management — request/response contracts shared by the API and
 * web. SSH credentials are write-only: the browser sends `password` on
 * create/edit but it is never returned (the read shape has `hasPassword`).
 */

/** Per-switch alert categories. Each transition fires a notification when on. */
export const ciscoAlertPrefsSchema = z.object({
  deviceOffline: z.boolean().default(false),
  portStateChange: z.boolean().default(false),
  configChange: z.boolean().default(false),
  uptimeChange: z.boolean().default(false),
});
export type CiscoAlertPrefs = z.infer<typeof ciscoAlertPrefsSchema>;

export const CISCO_ALERT_CATEGORIES: Array<{ key: keyof CiscoAlertPrefs; label: string; description: string }> = [
  { key: "deviceOffline", label: "Device offline", description: "The switch becomes unreachable (and recovers)." },
  { key: "portStateChange", label: "Port state change", description: "A port goes up or down between polls." },
  { key: "configChange", label: "Config change", description: "The running-config changed (a new backup was taken)." },
  { key: "uptimeChange", label: "Uptime change", description: "The switch rebooted (uptime reset)." },
];

/** Read-facing switch (no secret). List responses add the dashboard aggregates. */
export const ciscoSwitchSchema = z.object({
  id: z.string().uuid(),
  hostname: z.string(),
  ipAddress: z.string(),
  username: z.string(),
  model: z.string().nullable(),
  location: z.string().nullable(),
  reachable: z.boolean(),
  uptime: z.string().nullable(),
  lastPolledAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  configDrift: z.boolean(),
  checkPortState: z.boolean(),
  alertPrefs: ciscoAlertPrefsSchema,
  hasPassword: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  // Present on list rows (aggregated); optional on single-get.
  portCount: z.number().int().optional(),
  portsUp: z.number().int().optional(),
  portsDownEnabled: z.number().int().optional(),
});
export type CiscoSwitch = z.infer<typeof ciscoSwitchSchema>;

export const createCiscoSwitchSchema = z.object({
  hostname: z.string().min(1).max(128),
  ipAddress: z.string().min(1).max(45),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  model: z.string().max(128).optional(),
  location: z.string().max(128).optional(),
  checkPortState: z.boolean().optional(),
  alertPrefs: ciscoAlertPrefsSchema.partial().optional(),
});
export type CreateCiscoSwitchInput = z.infer<typeof createCiscoSwitchSchema>;

export const updateCiscoSwitchSchema = z.object({
  hostname: z.string().min(1).max(128).optional(),
  ipAddress: z.string().min(1).max(45).optional(),
  username: z.string().min(1).max(64).optional(),
  // Blank/omitted = keep the stored credential unchanged.
  password: z.string().max(128).optional(),
  model: z.string().max(128).nullable().optional(),
  location: z.string().max(128).nullable().optional(),
  checkPortState: z.boolean().optional(),
  alertPrefs: ciscoAlertPrefsSchema.partial().optional(),
});
export type UpdateCiscoSwitchInput = z.infer<typeof updateCiscoSwitchSchema>;

// ---- read-only output types (frontend typing; not validated on input) ----

export interface CiscoBackupListItem {
  id: string;
  backupType: "full" | "incremental" | "manual";
  backedUpAt: string;
  checksum: string;
  configSize: number;
}

export interface CiscoBackupDiffLine {
  type: "context" | "added" | "removed" | "separator";
  line: string;
}

export interface CiscoDriftEvent {
  id: string;
  portId: string; // '__device__' for switch-level
  field: string;
  expected: string | null;
  observed: string | null;
  detectedAt: string;
  resolvedAt: string | null;
}

export interface CiscoLookupRow {
  macAddress: string | null;
  ipAddress: string | null;
  rdnsName: string | null;
  vrf: string | null;
  switchId: string;
  switchHostname: string;
  portId: string | null;
  portDescription: string | null;
  vlan: number | null;
  macType: string | null;
  polledAt: string | null;
  uplinkNeighbor: string | null;
}

export interface CiscoArpOnlyRow {
  ipAddress: string;
  macAddress: string | null;
  interface: string | null;
  vlan: number | null;
  vrf: string | null;
  rdnsName: string | null;
  switchId: string;
  switchHostname: string;
  polledAt: string | null;
}

export interface CiscoVlanRow {
  vlanId: number;
  nameConflict: boolean;
  switches: Array<{ switchId: string; hostname: string; vlanName: string | null; vlanStatus: string | null }>;
}

// ---- ports (desired config editing) ----

export const ciscoPortInputSchema = z.object({
  portId: z.string().min(1).max(32),
  description: z.string().max(128).optional(),
  adminEnabled: z.boolean().optional(),
  speed: z.string().max(16).optional(),
  duplex: z.string().max(16).optional(),
  mode: z.enum(["access", "trunk"]).optional(),
  hasSwitchport: z.boolean().optional(),
  accessVlan: z.number().int().min(1).max(4094).optional(),
  trunkNativeVlan: z.number().int().min(1).max(4094).optional(),
  trunkAllowedVlans: z.string().max(255).optional(),
});
export type CiscoPortInput = z.infer<typeof ciscoPortInputSchema>;

export const updateCiscoPortSchema = ciscoPortInputSchema.partial();
export type UpdateCiscoPortInput = z.infer<typeof updateCiscoPortSchema>;

/** A desired port row joined with its observed live oper state. */
export interface CiscoPortRow {
  id: string;
  portId: string;
  description: string;
  adminEnabled: boolean;
  speed: string;
  duplex: string;
  mode: string;
  hasSwitchport: boolean;
  accessVlan: number;
  trunkNativeVlan: number;
  trunkAllowedVlans: string;
  operStatus: string | null;
  neighborHostname: string | null;
  neighborPort: string | null;
}

export interface CiscoBackupRow extends CiscoBackupListItem {
  switchId: string;
  switchHostname: string;
}

export interface CiscoDriftRow extends CiscoDriftEvent {
  switchId: string;
  switchHostname: string;
}

// ---- topology ----

export interface CiscoTopologyNode {
  id: string; // hostname
  label: string;
  kind: "switch" | "external";
  reachable?: boolean;
}
export interface CiscoTopologyEdge {
  a: string;
  b: string;
  aPort: string | null;
  bPort: string | null;
  protocol: string | null;
}
export interface CiscoTopology {
  nodes: CiscoTopologyNode[];
  edges: CiscoTopologyEdge[];
}
