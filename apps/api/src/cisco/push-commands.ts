import { defaultVlanName, normaliseDuplex, normaliseSpeed } from "@church/shared";
import { VLAN_FIELD_EXISTS, VLAN_FIELD_NAME, parseVlanScope } from "./vlan-drift";

export interface PushChange {
  portId: string;
  field: string;
  value: string | null;
  /** For a VLAN that is being created: the name it should get. */
  name?: string;
}

/**
 * The CLI lines that bring a switch to the given settings, in the order that keeps it valid: VLANs are created and
 * renamed first (a port cannot join one that does not exist), then device and interface settings, and VLANs are
 * removed last (after the ports that used them have moved). IOS and NX-OS take the same lines.
 */
export function buildPushCommands(changes: PushChange[]): string[] {
  const cmds: string[] = ["configure terminal"];
  const vlans = new Map<number, { exists: string | null; name: string | null }>();
  const byPort = new Map<string, Array<{ field: string; value: string | null }>>();
  const device: string[] = [];

  for (const c of changes) {
    if (c.portId === "__device__") {
      if (c.field === "hostname" && c.value) device.push(`hostname ${c.value}`);
      if (c.field === "location" && c.value) device.push(`snmp-server location ${c.value}`);
      continue;
    }
    const vlanId = parseVlanScope(c.portId);
    if (vlanId !== null) {
      const v = vlans.get(vlanId) ?? { exists: null, name: null };
      if (c.field === VLAN_FIELD_EXISTS) {
        v.exists = c.value === "1" ? "1" : "0";
        if (c.name !== undefined) v.name = c.name;
      } else if (c.field === VLAN_FIELD_NAME) v.name = c.value ?? "";
      vlans.set(vlanId, v);
      continue;
    }
    if (!byPort.has(c.portId)) byPort.set(c.portId, []);
    byPort.get(c.portId)!.push({ field: c.field, value: c.value });
  }

  const removals: number[] = [];
  for (const [id, v] of [...vlans].sort((a, b) => a[0] - b[0])) {
    if (v.exists === "0") {
      removals.push(id);
      continue;
    }
    cmds.push(`vlan ${id}`);
    if (v.name !== null) {
      const named = v.name !== "" && v.name !== defaultVlanName(id);
      cmds.push(named ? `name ${v.name}` : "no name");
    }
    cmds.push("exit");
  }

  cmds.push(...device);

  for (const [portId, fields] of byPort) {
    cmds.push(`interface ${portId}`);
    for (const f of fields) {
      switch (f.field) {
        case "admin_enabled":
          cmds.push(f.value === "1" || f.value === "true" ? "no shutdown" : "shutdown");
          break;
        case "description":
          cmds.push(f.value ? `description ${f.value}` : "no description");
          break;
        case "access_vlan":
          if (f.value) cmds.push(`switchport access vlan ${f.value}`);
          break;
        case "trunk_native_vlan":
          if (f.value) cmds.push(`switchport trunk native vlan ${f.value}`);
          break;
        case "trunk_allowed_vlans":
          if (f.value) cmds.push(`switchport trunk allowed vlan ${f.value}`);
          break;
        case "mode":
          if (f.value) cmds.push(`switchport mode ${f.value}`);
          break;
        case "speed":
          cmds.push(`speed ${normaliseSpeed(f.value)}`);
          break;
        case "duplex":
          cmds.push(`duplex ${normaliseDuplex(f.value)}`);
          break;
        default:
          break;
      }
    }
    cmds.push("exit");
  }

  for (const id of removals) cmds.push(`no vlan ${id}`);
  cmds.push("end", "write memory");

  // Every entry is one CLI line; a value with a line break would run as a second command on the switch.
  if (cmds.some((c) => /[\u0000-\u001f\u007f]/.test(c))) throw new Error("refusing to push a value with control characters");
  return cmds;
}

/**
 * A line of switch output that means a command was refused. The session itself succeeds either way, so without this a
 * rejected `no vlan` or a name already in use would look like a push that worked.
 */
export function findCliError(output: string): string | null {
  const m = /^.*(?:Invalid input detected|Incomplete command|Ambiguous command|% Invalid |Command rejected|^\s*ERROR:).*$/im.exec(output);
  return m ? m[0].trim().slice(0, 200) : null;
}
