import { defaultVlanName, isManagedVlan } from "@church/shared";

/** A VLAN drift event lives in cisco_drift_events with `port_id = "vlan:<id>"`; `field` is one of these. */
export const VLAN_FIELD_EXISTS = "vlan_exists";
export const VLAN_FIELD_NAME = "vlan_name";

export function vlanScope(vlanId: number): string {
  return `vlan:${vlanId}`;
}

/** The VLAN id of a drift event's `port_id`, or null when it is not a VLAN scope. */
export function parseVlanScope(portId: string): number | null {
  const m = /^vlan:(\d+)$/.exec(portId);
  return m ? Number(m[1]) : null;
}

export interface DesiredVlan {
  vlanId: number;
  /** Empty means the switch's default name ("VLAN0010"). */
  name: string;
}

export interface ObservedVlan {
  vlanId: number;
  vlanName: string | null;
}

export interface VlanDrift {
  vlanId: number;
  field: typeof VLAN_FIELD_EXISTS | typeof VLAN_FIELD_NAME;
  expected: string;
  observed: string;
}

/** The name a VLAN actually has: an unnamed one is "VLAN0010". */
export function effectiveVlanName(vlanId: number, name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  return n === "" ? defaultVlanName(vlanId) : n;
}

/**
 * Wanted against reported, for the VLANs a person can manage (not 1, not 1002-1005; those are on every switch and
 * cannot be changed). A VLAN that is wanted and absent, or present and not wanted, is `vlan_exists` ("1" / "0");
 * one that is on both with a different name is `vlan_name`. Names are compared exactly, as a switch stores them.
 */
export function computeVlanDrift(desired: DesiredVlan[], observed: ObservedVlan[]): VlanDrift[] {
  const want = new Map(desired.filter((d) => isManagedVlan(d.vlanId)).map((d) => [d.vlanId, d]));
  const have = new Map(observed.filter((o) => isManagedVlan(o.vlanId)).map((o) => [o.vlanId, o]));
  const out: VlanDrift[] = [];
  const ids = [...new Set([...want.keys(), ...have.keys()])].sort((a, b) => a - b);
  for (const id of ids) {
    const d = want.get(id);
    const o = have.get(id);
    if (d && !o) out.push({ vlanId: id, field: VLAN_FIELD_EXISTS, expected: "1", observed: "0" });
    else if (!d && o) out.push({ vlanId: id, field: VLAN_FIELD_EXISTS, expected: "0", observed: "1" });
    else if (d && o) {
      const expected = effectiveVlanName(id, d.name);
      const seen = effectiveVlanName(id, o.vlanName);
      if (expected !== seen) out.push({ vlanId: id, field: VLAN_FIELD_NAME, expected, observed: seen });
    }
  }
  return out;
}

/** The desired name to store for a VLAN seen on a switch: the default name is kept as "no name". */
export function desiredNameFromObserved(vlanId: number, observedName: string | null | undefined): string {
  const seen = effectiveVlanName(vlanId, observedName);
  return seen === defaultVlanName(vlanId) ? "" : seen;
}

/** Why a VLAN cannot be removed: what still uses it. */
export interface VlanUse {
  kind: "access_port" | "native_port" | "svi";
  detail: string;
}

export function describeVlanUse(use: VlanUse): string {
  return use.detail;
}
