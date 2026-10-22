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
  /** Port-channels count in the port-state check and its alerts (off by default: a bundle is down because its members are). */
  checkPortChannels: z.boolean().optional(),
  alertPrefs: ciscoAlertPrefsSchema,
  hasPassword: z.boolean(),
  /** The switch's SSH host key has been recorded; a different key is refused. */
  hostKeyPinned: z.boolean().optional(),
  /** The switch model an admin picked for this switch's picture (see setSwitchViewSchema); null = decided by the model text. */
  switchModelId: z.string().uuid().nullable().optional(),
  /** An admin turned the switch view off for this switch: its ports are listed only. */
  switchViewOff: z.boolean().optional(),
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
  checkPortChannels: z.boolean().optional(),
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
  checkPortChannels: z.boolean().optional(),
  alertPrefs: ciscoAlertPrefsSchema.partial().optional(),
});
export type UpdateCiscoSwitchInput = z.infer<typeof updateCiscoSwitchSchema>;

/**
 * Which switch model draws a switch's front-of-the-switch picture. "auto" (the default) matches the model text the switch
 * reports against each model's match strings; "model" is an admin's pick for this switch alone and beats that match;
 * "off" lists the ports with no picture. A "model" needs its id.
 */
export const setSwitchViewSchema = z
  .object({
    mode: z.enum(["auto", "model", "off"]),
    modelId: z.string().uuid().optional(),
  })
  .refine((v) => (v.mode === "model") === (v.modelId !== undefined), {
    message: "A model is needed for mode 'model', and only then",
    path: ["modelId"],
  });
export type SetSwitchViewInput = z.infer<typeof setSwitchViewSchema>;

// ---- read-only output types (frontend typing; not validated on input) ----

export interface CiscoBackupListItem {
  id: string;
  backupType: "full" | "incremental" | "manual" | "pre-change";
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

// ---- VLANs (layer 2) ----

/** VLAN 1 and the legacy FDDI / Token Ring VLANs (1002-1005) exist on every switch and cannot be added, renamed or removed. */
export function isManagedVlan(id: number): boolean {
  return Number.isInteger(id) && id >= 2 && id <= 4094 && !(id >= 1002 && id <= 1005);
}

/** The name a switch gives a VLAN that was never named: "VLAN0010". */
export function defaultVlanName(id: number): string {
  return `VLAN${String(id).padStart(4, "0")}`;
}

/** A VLAN name as a switch takes it: up to 32 letters, digits, dot, dash, underscore. Empty means the default name. */
export const vlanNameSchema = z
  .string()
  .trim()
  .max(32)
  .regex(/^[A-Za-z0-9_.-]*$/, "Letters, digits, dot, dash and underscore only");

/** "10,30-35" / "all" / "none" as a set of VLAN ids. Parts it cannot read are ignored. */
export function parseVlanList(raw: string | null | undefined): Set<number> {
  const out = new Set<number>();
  const text = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (text === "" || text === "none") return out;
  if (text === "all") {
    for (let v = 1; v <= 4094; v++) out.add(v);
    return out;
  }
  for (const part of text.split(",")) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b > 4094 || a > b) continue;
    for (let v = a; v <= b; v++) out.add(v);
  }
  return out;
}

/** A set of VLAN ids as the shortest list a switch accepts: "1,5,10-12". Empty is "none". */
export function formatVlanList(ids: Iterable<number>): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (sorted.length === 0) return "none";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = start;
  for (const v of sorted.slice(1)) {
    if (v === prev + 1) {
      prev = v;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = prev = v;
  }
  parts.push(start === prev ? String(start) : `${start}-${prev}`);
  return parts.join(",");
}

/** One spelling of a trunk's allowed list, so "all", "1-4094", "103,30" and "30,103" compare equal where they should. */
export function normaliseVlanList(raw: string | null | undefined): string {
  return formatVlanList(parseVlanList(raw));
}

/**
 * How one switch's wanted VLAN compares with what the switch reports.
 * in_sync, missing (wanted, not on the switch), extra (on the switch, not wanted), name (both, names differ).
 */
export type CiscoVlanState = "in_sync" | "missing" | "extra" | "name";

export interface CiscoVlanSwitchRow {
  switchId: string;
  hostname: string;
  /** Observed: what the last poll saw (null when the switch does not have it). */
  vlanName: string | null;
  vlanStatus: string | null;
  /** Wanted: the dashboard's desired config for this switch. */
  desired: boolean;
  desiredName: string | null;
  state: CiscoVlanState;
}

export interface CiscoVlanRow {
  vlanId: number;
  nameConflict: boolean;
  /** False for VLAN 1 and 1002-1005: shown, never edited. */
  managed: boolean;
  switches: CiscoVlanSwitchRow[];
}

/** A VLAN a switch's ports can be put in (the dashboard's desired list for it, plus VLAN 1). */
export interface CiscoSwitchVlan {
  vlanId: number;
  /** The name it has: an unnamed VLAN shows as "VLAN0010". */
  name: string;
}

/** Body of PUT /cisco/vlans/:vlanId: the VLAN's name and the switches that should have it (others lose it). */
export const ciscoVlanSetSchema = z.object({
  name: vlanNameSchema,
  switchIds: z.array(z.string().uuid()).min(1).max(200),
});
export type CiscoVlanSetInput = z.infer<typeof ciscoVlanSetSchema>;

export interface CiscoVlanSetResult {
  vlanId: number;
  created: string[];
  renamed: string[];
  removed: string[];
  unchanged: string[];
}

// ---- ports (desired config editing) ----

/**
 * Speed as the switch writes it in `speed <n>`: Mbps as a bare number, or "auto". Old rows and typed input may say
 * "1G" / "100M" / "1000 Mbps"; every comparison, save and push goes through this so those all mean the same thing.
 * Anything it does not recognise is kept (lower-cased) so a typo shows up as drift instead of vanishing.
 */
export function normaliseSpeed(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "");
  if (s === "" || s === "auto" || s.startsWith("auto")) return "auto";
  const g = /^(\d+(?:\.\d+)?)g(?:bps|b)?$/.exec(s);
  if (g) return String(Math.round(Number(g[1]) * 1000));
  const m = /^(\d+)(?:m(?:bps|b)?)?$/.exec(s);
  if (m) return m[1]!;
  return s;
}

/** `duplex auto|full|half`; blank means auto. */
export function normaliseDuplex(raw: string | null | undefined): string {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "" ? "auto" : s;
}

/** Speeds offered in the port editor (value is what the switch is given). */
export const CISCO_SPEED_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "10", label: "10 Mbps" },
  { value: "100", label: "100 Mbps" },
  { value: "1000", label: "1 Gbps" },
  { value: "2500", label: "2.5 Gbps" },
  { value: "5000", label: "5 Gbps" },
  { value: "10000", label: "10 Gbps" },
  { value: "25000", label: "25 Gbps" },
  { value: "40000", label: "40 Gbps" },
  { value: "100000", label: "100 Gbps" },
];

export const CISCO_DUPLEX_CHOICES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "full", label: "Full" },
  { value: "half", label: "Half" },
];

/** "1 Gbps" for a stored speed; an unknown value is shown as it is. */
export function speedLabel(raw: string | null | undefined): string {
  const v = normaliseSpeed(raw);
  return CISCO_SPEED_CHOICES.find((c) => c.value === v)?.label ?? v;
}

export const ciscoPortInputSchema = z.object({
  // An interface name (Gi1/0/1, Po1, Ethernet1/1, mgmt0): it is typed into `interface <name>` on the switch, so no spaces
  // ("interface range ..." would be every port), separators or anything else.
  portId: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z][A-Za-z-]{0,30}\d[\d/.:]{0,20}$/, "Use an interface name such as Gi1/0/1"),
  // A description is sent to the switch as one CLI line, so no line breaks or control characters.
  description: z
    .string()
    .max(128)
    .regex(/^[^\u0000-\u001f\u007f]*$/, "No line breaks or control characters")
    .optional(),
  adminEnabled: z.boolean().optional(),
  speed: z.string().max(16).regex(/^\s*(?:auto\w*|\d{1,6}(?:\.\d+)?\s*[mMgG]?(?:bps|b)?)?\s*$/, "Use auto or a speed such as 100, 1000 or 1G").optional(),
  duplex: z.string().max(16).regex(/^\s*(?:auto|full|half)?\s*$/i, "Use auto, full or half").optional(),
  mode: z.enum(["access", "trunk"]).optional(),
  hasSwitchport: z.boolean().optional(),
  accessVlan: z.number().int().min(1).max(4094).optional(),
  trunkNativeVlan: z.number().int().min(1).max(4094).optional(),
  trunkAllowedVlans: z
    .string()
    .max(255)
    .regex(/^\s*(?:all|none|(?:(?:add|remove|except)\s+)?\d{1,4}(?:-\d{1,4})?(?:,\d{1,4}(?:-\d{1,4})?)*)?\s*$/i, "Use VLAN numbers and ranges such as 10,20-30, all or none")
    .optional(),
});
export type CiscoPortInput = z.infer<typeof ciscoPortInputSchema>;

export const updateCiscoPortSchema = ciscoPortInputSchema.partial();
export type UpdateCiscoPortInput = z.infer<typeof updateCiscoPortSchema>;

/** What a PoE port is doing, as the switch last reported it. */
export interface CiscoPortPoe {
  /** "on" while it powers a device; otherwise off, faulty, power-deny ... */
  status: string;
  /** "Ieee PD", "Cisco IP Phone 7960"; null when unknown. */
  device: string | null;
  /** IEEE class 0-8; null when unknown. */
  ieeeClass: number | null;
  /** Milliwatts set aside for the device. */
  allocatedMw: number | null;
  /** Milliwatts the port actually delivers now. */
  measuredMw: number | null;
}

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
  /** Null for a port the switch has no PoE reading for (no PoE hardware, or not polled yet). */
  poe: CiscoPortPoe | null;
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
