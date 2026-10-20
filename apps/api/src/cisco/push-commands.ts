import { defaultVlanName, normaliseDuplex, normaliseSpeed } from "@church/shared";
import { VLAN_FIELD_EXISTS, VLAN_FIELD_NAME, parseVlanScope } from "./vlan-drift";

/**
 * Every value that becomes a CLI line is checked here, at the one place lines are built, whatever route it came by (the
 * port editor, a drift row, the VLAN list). A switch runs what it is sent, and a value is typed straight into a
 * configuration session: `interface range Gi1/0/1-48` or `speed 1000 ; reload` would be a command, not a setting.
 */
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Gi1/0/1, Te1/0/1:1, Port-channel10, Ethernet1/1.100, mgmt0, Vlan10: letters, then digits and separators, no spaces. */
const INTERFACE_NAME = /^[A-Za-z][A-Za-z-]{0,30}\d[\d/.:]{0,20}$/;
const VLAN_LIST = /^(?:all|none|(?:(?:add|remove|except)\s+)?\d{1,4}(?:-\d{1,4})?(?:,\d{1,4}(?:-\d{1,4})?)*)$/i;
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const VLAN_NAME = /^[\x21-\x7e][\x20-\x7e]{0,31}$/;

function refuse(what: string): never {
  throw new Error(`refusing to push ${what}`);
}

function text(value: string, what: string, max = 240): string {
  if (CONTROL.test(value)) refuse(`a value with control characters (${what})`);
  if (value.length > max) refuse(`${what} longer than ${max} characters`);
  return value;
}

function vlanNumber(value: string, what: string): string {
  if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 4094) refuse(`${what} that is not a VLAN number`);
  return value;
}

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
 * removed last (after the ports that used them have moved). IOS and NX-OS take the same lines. `save: false` stops at
 * `end` (the running configuration only): the caller saves to the startup configuration separately, once the switch
 * has accepted every line.
 */
export function buildPushCommands(changes: PushChange[], options: { save?: boolean } = {}): string[] {
  const cmds: string[] = ["configure terminal"];
  const vlans = new Map<number, { exists: string | null; name: string | null }>();
  const byPort = new Map<string, Array<{ field: string; value: string | null }>>();
  const device: string[] = [];

  for (const c of changes) {
    if (c.portId === "__device__") {
      if (c.field === "hostname" && c.value) {
        if (!HOSTNAME.test(c.value)) refuse("a host name that is not a plain name");
        device.push(`hostname ${c.value}`);
      }
      if (c.field === "location" && c.value) device.push(`snmp-server location ${text(c.value, "location")}`);
      continue;
    }
    const vlanId = parseVlanScope(c.portId);
    if (vlanId !== null) {
      const v = vlans.get(vlanId) ?? { exists: null, name: null };
      if (c.field === VLAN_FIELD_EXISTS) {
        v.exists = c.value === "1" ? "1" : "0";
        if (c.name !== undefined) v.name = c.name;
      } else if (c.field === VLAN_FIELD_NAME) v.name = c.value ?? "";
      if (v.name !== null && v.name !== "" && !CONTROL.test(v.name) && !VLAN_NAME.test(v.name)) refuse("a VLAN name that is not 1-32 printable characters");
      vlans.set(vlanId, v);
      continue;
    }
    if (CONTROL.test(c.portId)) refuse("a value with control characters (port name)");
    if (!INTERFACE_NAME.test(c.portId)) refuse(`a port name that is not an interface name (${JSON.stringify(c.portId.slice(0, 40))})`);
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
          if (!["1", "true", "0", "false"].includes(String(f.value))) refuse("an admin state that is not on or off");
          cmds.push(f.value === "1" || f.value === "true" ? "no shutdown" : "shutdown");
          break;
        case "description":
          cmds.push(f.value ? `description ${text(f.value, "description", 200)}` : "no description");
          break;
        case "access_vlan":
          if (f.value) cmds.push(`switchport access vlan ${vlanNumber(f.value, "an access VLAN")}`);
          break;
        case "trunk_native_vlan":
          if (f.value) cmds.push(`switchport trunk native vlan ${vlanNumber(f.value, "a native VLAN")}`);
          break;
        case "trunk_allowed_vlans":
          if (f.value) {
            if (!VLAN_LIST.test(f.value.trim())) refuse("an allowed-VLAN list that is not VLAN numbers, ranges, all or none");
            cmds.push(`switchport trunk allowed vlan ${f.value.trim()}`);
          }
          break;
        case "mode":
          if (f.value) {
            if (f.value !== "access" && f.value !== "trunk") refuse("a switchport mode that is not access or trunk");
            cmds.push(`switchport mode ${f.value}`);
          }
          break;
        case "speed": {
          const speed = normaliseSpeed(f.value);
          if (!/^(auto|\d{2,6})$/.test(speed)) refuse("a speed that is not auto or a number of Mbps");
          cmds.push(`speed ${speed}`);
          break;
        }
        case "duplex": {
          const duplex = normaliseDuplex(f.value);
          if (!["auto", "full", "half"].includes(duplex)) refuse("a duplex that is not auto, full or half");
          cmds.push(`duplex ${duplex}`);
          break;
        }
        default:
          break;
      }
    }
    cmds.push("exit");
  }

  for (const id of removals) cmds.push(`no vlan ${id}`);
  cmds.push("end");
  if (options.save !== false) cmds.push("write memory");

  // Every entry is one CLI line; a value with a line break would run as a second command on the switch.
  if (cmds.some((c) => CONTROL.test(c))) throw new Error("refusing to push a value with control characters");
  return cmds;
}

/**
 * A line of switch output that means a command was refused. The session itself succeeds either way, so without this a
 * rejected `no vlan` or a name already in use would look like a push that worked.
 */
export function findCliError(output: string): string | null {
  const m =
    /^.*(?:Invalid input detected|Incomplete command|Ambiguous command|% Invalid |Command rejected|% Unknown command|% Unrecognized command|authorization failed|% Access denied|% Permission denied|^\s*ERROR:).*$/im.exec(
      output,
    );
  return m ? m[0].trim().slice(0, 200) : null;
}
