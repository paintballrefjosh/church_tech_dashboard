import { parseVlanList } from "./schemas/cisco";
import type { CiscoPortRow } from "./schemas/cisco";

/**
 * The printable port sheet of a switch: a picture of the device, and a table of every port with its description and
 * the VLAN / subnet it is in. The rows are made here (pure, unit-tested) from what the Cisco poller and the UniFi
 * controller report; the pages only draw them.
 */

export interface PortSheetRow {
  port: string;
  description: string;
  /** "access", "trunk", "routed", "disabled" ... as the device calls it. */
  mode: string;
  /** "10 Staff" for an access port, "trunk, native 1; allowed 10,20" for a trunk. */
  vlan: string;
  /** "10.0.10.0/24" (one per VLAN named in `vlan`, labelled with the VLAN when there are several). */
  subnet: string;
  /** Link state in a word: up, down, shut, disabled ... */
  link: string;
}

export interface PortSheet {
  kind: "cisco" | "unifi";
  device: {
    id: string;
    name: string;
    ip: string | null;
    model: string | null;
    location: string | null;
    /** The picture choice made for the device (Cisco: its page; UniFi: the device list), so the sheet uses the same picture. */
    switchModelId?: string | null;
    switchViewOff?: boolean;
  };
  generatedAt: string;
  ports: PortSheetRow[];
  /** Plain-language caveats shown under the table ("VLAN names unavailable ..."). */
  notes: string[];
}

export interface VlanLookup {
  /** The VLAN's name on this device, or null. */
  name(id: number): string | null;
  /** Subnets (CIDR) routed on the VLAN, or []. */
  subnets(id: number): string[];
}

/** Port names in the order a person reads them: Gi1/0/2 before Gi1/0/10. */
export function comparePortNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

const NO_VALUE = "-";
/** A trunk that lists more VLANs than this has them summarised rather than spelt out in a table cell. */
const MAX_VLANS_SPELT_OUT = 6;

function vlanLabel(id: number, lookup: VlanLookup): string {
  const name = lookup.name(id);
  return name ? `${id} ${name}` : String(id);
}

function subnetText(ids: number[], lookup: VlanLookup, labelled: boolean): string {
  const parts: string[] = [];
  for (const id of ids) {
    const subs = lookup.subnets(id);
    if (subs.length === 0) continue;
    parts.push(labelled ? `${id}: ${subs.join(", ")}` : subs.join(", "));
  }
  return parts.length > 0 ? parts.join("; ") : NO_VALUE;
}

function linkOf(p: Pick<CiscoPortRow, "adminEnabled" | "operStatus">): string {
  if (!p.adminEnabled) return "shut";
  return p.operStatus ?? NO_VALUE;
}

/** One printable row per Cisco port. */
export function ciscoSheetRows(ports: readonly CiscoPortRow[], lookup: VlanLookup): PortSheetRow[] {
  return [...ports]
    .sort((a, b) => comparePortNames(a.portId, b.portId))
    .map((p) => {
      const base = { port: p.portId, description: p.description.trim(), link: linkOf(p) };
      if (!p.hasSwitchport) return { ...base, mode: "routed", vlan: "routed", subnet: NO_VALUE };
      if (p.mode === "trunk") {
        const allowed = parseVlanList(p.trunkAllowedVlans);
        const native = p.trunkNativeVlan;
        const everything = allowed.size >= 4000;
        // Tagged VLANs are the allowed ones except the native (untagged) one.
        const tagged = [...allowed].filter((v) => v !== native).sort((a, b) => a - b);
        let vlan = `trunk, native ${vlanLabel(native, lookup)}`;
        let subnetIds = [native];
        if (everything) {
          vlan += "; all VLANs";
        } else if (tagged.length === 0) {
          vlan += "; no tagged VLANs";
        } else if (tagged.length <= MAX_VLANS_SPELT_OUT) {
          vlan += `; tagged ${tagged.map((v) => vlanLabel(v, lookup)).join(", ")}`;
          subnetIds = [native, ...tagged];
        } else {
          vlan += `; ${tagged.length} tagged VLANs`;
        }
        return { ...base, mode: "trunk", vlan, subnet: subnetText(subnetIds, lookup, subnetIds.length > 1) };
      }
      return {
        ...base,
        mode: "access",
        vlan: vlanLabel(p.accessVlan, lookup),
        subnet: subnetText([p.accessVlan], lookup, false),
      };
    });
}

// ---- UniFi ----

/** The few fields of a UniFi switch port we read; the controller sends many more and they vary by firmware. */
export interface UnifiPortLike {
  port_idx?: number;
  name?: string;
  up?: boolean;
  enable?: boolean;
  speed?: number;
  portconf_id?: string;
  native_networkconf_id?: string;
  op_mode?: string;
  /** "all" | "native" | "customize" | "disabled", on port profiles. */
  forward?: string;
}
export interface UnifiOverrideLike {
  port_idx?: number;
  name?: string;
  portconf_id?: string;
  native_networkconf_id?: string;
}
export interface UnifiProfileLike {
  _id?: string;
  name?: string;
  forward?: string;
  native_networkconf_id?: string;
  tagged_networkconf_ids?: string[];
  excluded_networkconf_ids?: string[];
}
export interface UnifiNetworkLike {
  _id?: string;
  name?: string;
  vlan?: number | string;
  vlan_enabled?: boolean;
  ip_subnet?: string;
  purpose?: string;
}

/** "10.0.10.1/24" (host bits as the controller stores it) as the subnet "10.0.10.0/24"; anything else is returned as it came. */
export function unifiSubnetCidr(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(text);
  if (!m) return text || null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255) || prefix < 0 || prefix > 32) return text;
  const ip = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const net = (ip & mask) >>> 0;
  return `${net >>> 24}.${(net >>> 16) & 255}.${(net >>> 8) & 255}.${net & 255}/${prefix}`;
}

/** UniFi names an unnamed port "Port 7"; that is not a description. */
function isDefaultPortName(name: string, idx: number | undefined): boolean {
  return idx !== undefined && name.trim().toLowerCase() === `port ${idx}`;
}

function networkText(n: UnifiNetworkLike | undefined): { vlan: string; subnet: string } {
  if (!n) return { vlan: NO_VALUE, subnet: NO_VALUE };
  const name = (n.name ?? "").trim() || "network";
  const id = n.vlan_enabled && n.vlan != null && Number(n.vlan) > 0 ? Number(n.vlan) : null;
  // The default network carries no VLAN tag: it is VLAN 1 untagged.
  const vlan = id !== null ? `${id} ${name}` : name;
  return { vlan, subnet: unifiSubnetCidr(n.ip_subnet) ?? NO_VALUE };
}

/**
 * One printable row per switch port. A port's network comes from its profile (`portconf_id`, with the per-port override
 * winning over the live table), or from its own `native_networkconf_id` when it has no profile; tagged networks are the
 * profile's allowed list. A port that is switched off by its profile shows "disabled".
 */
export function unifiSheetRows(
  device: { port_table?: UnifiPortLike[]; port_overrides?: UnifiOverrideLike[] },
  profiles: readonly UnifiProfileLike[],
  networks: readonly UnifiNetworkLike[],
): PortSheetRow[] {
  const profileById = new Map(profiles.filter((p) => p._id).map((p) => [p._id as string, p]));
  const networkById = new Map(networks.filter((n) => n._id).map((n) => [n._id as string, n]));
  const overrideByIdx = new Map((device.port_overrides ?? []).filter((o) => typeof o.port_idx === "number").map((o) => [o.port_idx as number, o]));

  return [...(device.port_table ?? [])]
    .filter((p) => typeof p.port_idx === "number")
    .sort((a, b) => (a.port_idx as number) - (b.port_idx as number))
    .map((p) => {
      const idx = p.port_idx as number;
      const override = overrideByIdx.get(idx);
      const profile = profileById.get(override?.portconf_id ?? p.portconf_id ?? "");
      const customName = (override?.name ?? p.name ?? "").trim();
      const description = isDefaultPortName(customName, idx) ? "" : customName;
      const disabled = profile?.forward === "disabled" || p.enable === false;
      const nativeId = override?.native_networkconf_id ?? profile?.native_networkconf_id ?? p.native_networkconf_id;
      const native = networkText(networkById.get(nativeId ?? ""));
      const link = disabled ? "disabled" : p.up ? "up" : "down";
      const profileName = (profile?.name ?? "").trim();

      if (disabled) {
        return { port: String(idx), description, mode: "disabled", vlan: profileName || "disabled", subnet: NO_VALUE, link };
      }

      // "customize" lists the tagged networks; "all" carries every network tagged.
      const tagged = profile?.forward === "customize" ? (profile.tagged_networkconf_ids ?? []) : [];
      const taggedNetworks = tagged.map((id) => networkById.get(id)).filter((n): n is UnifiNetworkLike => n !== undefined);
      const carriesAll = profile?.forward === "all";

      let vlan = native.vlan;
      let subnet = native.subnet;
      let mode = "access";
      if (carriesAll) {
        mode = "trunk";
        vlan = `${native.vlan}; all networks tagged`;
      } else if (taggedNetworks.length > 0) {
        mode = "trunk";
        const shown = taggedNetworks.slice(0, MAX_VLANS_SPELT_OUT).map((n) => networkText(n));
        vlan = `${native.vlan}; tagged ${shown.map((s) => s.vlan).join(", ")}${taggedNetworks.length > shown.length ? ` +${taggedNetworks.length - shown.length} more` : ""}`;
        if (shown.length <= MAX_VLANS_SPELT_OUT && taggedNetworks.length <= MAX_VLANS_SPELT_OUT) {
          subnet = [native.subnet, ...shown.map((s) => s.subnet)].filter((s) => s !== NO_VALUE).join("; ") || NO_VALUE;
        }
      }
      if (profileName && profileName.toLowerCase() !== "all") vlan = `${vlan} (profile ${profileName})`;
      return { port: String(idx), description, mode, vlan, subnet, link };
    });
}
