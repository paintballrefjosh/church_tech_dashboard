import { describe, expect, it } from "vitest";
import { ciscoPortInputSchema, updateCiscoPortSchema } from "@church/shared";
import { buildPushCommands, findCliError } from "../src/cisco/push-commands";

const port = (field: string, value: string | null, portId = "Gi1/0/1") => [{ portId, field, value }];

describe("buildPushCommands refuses anything that is not a setting", () => {
  it("accepts ordinary interface names", () => {
    for (const id of ["Gi1/0/1", "GigabitEthernet1/0/24", "Te1/0/1:1", "Po1", "Port-channel10", "Ethernet1/1", "Ethernet1/1.100", "mgmt0", "Vlan10", "Loopback0"]) {
      expect(buildPushCommands(port("admin_enabled", "1", id))).toContain(`interface ${id}`);
    }
  });

  it("refuses a port name that would address more than one port or run a second command", () => {
    for (const id of ["range Gi1/0/1-48", "Gi1/0/1 ; reload", "Gi1/0/1,Gi1/0/2", "Gi1/0/1 shutdown", "", "1/0/1", "../x", "Gi 1/0/1"]) {
      expect(() => buildPushCommands(port("admin_enabled", "0", id)), JSON.stringify(id)).toThrow(/interface name|control characters/);
    }
  });

  it("refuses values that are not what the setting takes", () => {
    const bad: Array<[string, string]> = [
      ["admin_enabled", "maybe"],
      ["speed", "1000 ; reload"],
      ["speed", "warp"],
      ["duplex", "full ; reload"],
      ["mode", "access ; reload"],
      ["access_vlan", "10 ; reload"],
      ["access_vlan", "0"],
      ["access_vlan", "4095"],
      ["trunk_native_vlan", "ten"],
      ["trunk_allowed_vlans", "10,20 ; reload"],
      ["trunk_allowed_vlans", "add"],
    ];
    for (const [field, value] of bad) expect(() => buildPushCommands(port(field, value)), `${field}=${value}`).toThrow(/refusing to push/);
  });

  it("keeps the values a switch is normally given", () => {
    const cmds = buildPushCommands([
      { portId: "Gi1/0/1", field: "admin_enabled", value: "1" },
      { portId: "Gi1/0/1", field: "speed", value: "1G" },
      { portId: "Gi1/0/1", field: "duplex", value: "Full" },
      { portId: "Gi1/0/1", field: "mode", value: "trunk" },
      { portId: "Gi1/0/1", field: "trunk_allowed_vlans", value: "10,20-30" },
      { portId: "Gi1/0/1", field: "trunk_native_vlan", value: "99" },
      { portId: "Gi1/0/2", field: "trunk_allowed_vlans", value: "all" },
      { portId: "Gi1/0/2", field: "description", value: "Camera 1 (stage left)" },
    ]);
    expect(cmds).toEqual([
      "configure terminal",
      "interface Gi1/0/1", "no shutdown", "speed 1000", "duplex full", "switchport mode trunk", "switchport trunk allowed vlan 10,20-30", "switchport trunk native vlan 99", "exit",
      "interface Gi1/0/2", "switchport trunk allowed vlan all", "description Camera 1 (stage left)", "exit",
      "end", "write memory",
    ]);
  });

  it("can leave the save out, for a caller that saves after checking", () => {
    expect(buildPushCommands(port("speed", "100"), { save: false }).at(-1)).toBe("end");
  });

  it("checks the device and VLAN lines too", () => {
    expect(() => buildPushCommands([{ portId: "__device__", field: "hostname", value: "sw1; reload" }])).toThrow(/host name/);
    expect(() => buildPushCommands([{ portId: "__device__", field: "hostname", value: "sw 1" }])).toThrow(/host name/);
    expect(buildPushCommands([{ portId: "__device__", field: "hostname", value: "core-sw.1" }])).toContain("hostname core-sw.1");
    expect(() => buildPushCommands([{ portId: "vlan:10", field: "vlan_name", value: "x".repeat(40) }])).toThrow(/VLAN name/);
  });
});

describe("findCliError also sees refusals about rights", () => {
  it("catches authorization and permission failures", () => {
    for (const out of ["% Authorization failed.", "Command authorization failed.", "% Access denied", "% Permission denied", "% Unknown command or computer name", "% Unrecognized command"]) {
      expect(findCliError(`sw1#${out}\nsw1#`), out).not.toBeNull();
    }
  });
  it("does not mistake an ordinary warning for a refusal", () => {
    expect(findCliError("%Warning: portfast should only be enabled on ports connected to a single host.\n")).toBeNull();
  });
});

describe("port input is validated where it enters", () => {
  it("accepts what the editor sends", () => {
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", speed: "auto", duplex: "full", mode: "trunk", trunkAllowedVlans: "10,20-30", accessVlan: 10 }).success).toBe(true);
    expect(updateCiscoPortSchema.safeParse({ speed: "1000", duplex: "", trunkAllowedVlans: "" }).success).toBe(true);
  });
  it("refuses a port name, speed, duplex or VLAN list that is not a setting", () => {
    expect(ciscoPortInputSchema.safeParse({ portId: "range Gi1/0/1-48" }).success).toBe(false);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", speed: "1000 ; reload" }).success).toBe(false);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", duplex: "full ; reload" }).success).toBe(false);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", trunkAllowedVlans: "10 ; reload" }).success).toBe(false);
  });
});
