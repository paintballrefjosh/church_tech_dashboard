import { describe, expect, it } from "vitest";
import {
  ciscoPortInputSchema,
  ciscoVlanSetSchema,
  defaultVlanName,
  formatVlanList,
  isManagedVlan,
  normaliseVlanList,
  parseVlanList,
} from "@church/shared";
import { computeVlanDrift, desiredNameFromObserved, effectiveVlanName, parseVlanScope, vlanScope } from "../src/cisco/vlan-drift";
import { buildPushCommands, findCliError } from "../src/cisco/push-commands";
import { parseVlans } from "../src/cisco/parsers";

describe("VLAN lists", () => {
  it("reads ranges, all and none", () => {
    expect([...parseVlanList("10,30-32")]).toEqual([10, 30, 31, 32]);
    expect(parseVlanList("all").size).toBe(4094);
    expect(parseVlanList("none").size).toBe(0);
    expect(parseVlanList("").size).toBe(0);
    // spaces are ignored; a part that is not a list, is out of range or runs backwards is dropped
    expect([...parseVlanList("5, 7 -9 ,x,4095,9-7")]).toEqual([5, 7, 8, 9]);
  });

  it("writes the shortest form, so spellings of one set compare equal", () => {
    expect(formatVlanList([3, 1, 2, 10, 12, 11, 30])).toBe("1-3,10-12,30");
    expect(normaliseVlanList("103,30,32-35")).toBe("30,32-35,103");
    expect(normaliseVlanList("30,32-35,103")).toBe("30,32-35,103");
    expect(normaliseVlanList("all")).toBe("1-4094");
    expect(normaliseVlanList("1-4094")).toBe("1-4094");
    expect(normaliseVlanList("none")).toBe("none");
    expect(normaliseVlanList("")).toBe("none");
  });
});

describe("VLAN rules", () => {
  it("manages 2-4094 except the legacy 1002-1005", () => {
    for (const v of [1, 1002, 1003, 1004, 1005, 0, 4095, 2.5]) expect(isManagedVlan(v)).toBe(false);
    for (const v of [2, 10, 1001, 1006, 4094]) expect(isManagedVlan(v)).toBe(true);
  });

  it("names unnamed VLANs the way a switch does", () => {
    expect(defaultVlanName(10)).toBe("VLAN0010");
    expect(effectiveVlanName(258, "")).toBe("VLAN0258");
    expect(effectiveVlanName(258, null)).toBe("VLAN0258");
    expect(effectiveVlanName(258, "servers")).toBe("servers");
    expect(desiredNameFromObserved(258, "VLAN0258")).toBe("");
    expect(desiredNameFromObserved(258, "servers")).toBe("servers");
  });

  it("checks the request bodies", () => {
    const sw = "22222222-2222-4222-8222-222222222222";
    expect(ciscoVlanSetSchema.safeParse({ name: "josh_user", switchIds: [sw] }).success).toBe(true);
    expect(ciscoVlanSetSchema.safeParse({ name: "", switchIds: [sw] }).success).toBe(true);
    expect(ciscoVlanSetSchema.safeParse({ name: "has space", switchIds: [sw] }).success).toBe(false);
    expect(ciscoVlanSetSchema.safeParse({ name: "x\nshutdown", switchIds: [sw] }).success).toBe(false);
    expect(ciscoVlanSetSchema.safeParse({ name: "a".repeat(33), switchIds: [sw] }).success).toBe(false);
    expect(ciscoVlanSetSchema.safeParse({ name: "ok", switchIds: [] }).success).toBe(false);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", trunkAllowedVlans: "10,30-35" }).success).toBe(true);
  });

  it("scopes drift events by VLAN", () => {
    expect(vlanScope(10)).toBe("vlan:10");
    expect(parseVlanScope("vlan:10")).toBe(10);
    expect(parseVlanScope("Gi1/0/1")).toBeNull();
    expect(parseVlanScope("__device__")).toBeNull();
  });
});

describe("computeVlanDrift", () => {
  const want = (vlanId: number, name = "") => ({ vlanId, name });
  const have = (vlanId: number, vlanName: string | null) => ({ vlanId, vlanName });

  it("is quiet when wanted and reported agree, default names included", () => {
    expect(computeVlanDrift([want(10, "servers"), want(258)], [have(10, "servers"), have(258, "VLAN0258")])).toEqual([]);
  });

  it("reports a wanted VLAN the switch lacks, and one the switch has that is not wanted", () => {
    expect(computeVlanDrift([want(10, "a"), want(20, "b")], [have(10, "a"), have(30, "c")])).toEqual([
      { vlanId: 20, field: "vlan_exists", expected: "1", observed: "0" },
      { vlanId: 30, field: "vlan_exists", expected: "0", observed: "1" },
    ]);
  });

  it("reports a different name, compared exactly, with default names filled in", () => {
    expect(computeVlanDrift([want(10, "Servers")], [have(10, "servers")])).toEqual([
      { vlanId: 10, field: "vlan_name", expected: "Servers", observed: "servers" },
    ]);
    expect(computeVlanDrift([want(10)], [have(10, "servers")])).toEqual([
      { vlanId: 10, field: "vlan_name", expected: "VLAN0010", observed: "servers" },
    ]);
  });

  it("never reports VLAN 1 or the legacy VLANs", () => {
    expect(computeVlanDrift([], [have(1, "default"), have(1002, "fddi-default"), have(1005, "trnet-default")])).toEqual([]);
    expect(computeVlanDrift([want(1, "x")], [])).toEqual([]);
  });
});

describe("push commands", () => {
  it("creates and renames VLANs first, ports next, removes VLANs last", () => {
    const cmds = buildPushCommands([
      { portId: "vlan:300", field: "vlan_exists", value: "0" },
      { portId: "Gi1/0/5", field: "access_vlan", value: "100" },
      { portId: "vlan:100", field: "vlan_exists", value: "1", name: "cameras" },
      { portId: "vlan:110", field: "vlan_name", value: "printers" },
      { portId: "vlan:120", field: "vlan_name", value: "VLAN0120" },
      { portId: "vlan:130", field: "vlan_exists", value: "1", name: "VLAN0130" },
    ]);
    expect(cmds).toEqual([
      "configure terminal",
      "vlan 100",
      "name cameras",
      "exit",
      "vlan 110",
      "name printers",
      "exit",
      "vlan 120",
      "no name",
      "exit",
      "vlan 130",
      "no name",
      "exit",
      "interface Gi1/0/5",
      "switchport access vlan 100",
      "exit",
      "no vlan 300",
      "end",
      "write memory",
    ]);
  });

  it("keeps the earlier port and device commands as they were", () => {
    expect(
      buildPushCommands([
        { portId: "__device__", field: "hostname", value: "SW1" },
        { portId: "Gi1/0/1", field: "speed", value: "1G" },
        { portId: "Gi1/0/1", field: "trunk_allowed_vlans", value: "30,32-35" },
      ]),
    ).toEqual(["configure terminal", "hostname SW1", "interface Gi1/0/1", "speed 1000", "switchport trunk allowed vlan 30,32-35", "exit", "end", "write memory"]);
  });

  it("refuses a value that would run as a second command", () => {
    expect(() => buildPushCommands([{ portId: "vlan:10", field: "vlan_name", value: "a\nreload" }])).toThrow(/control characters/);
  });
});

describe("findCliError", () => {
  it("spots the switch refusing a command, and ignores ordinary output", () => {
    expect(findCliError("SW1(config)#vlan 5000\n% Invalid input detected at '^' marker.\nSW1(config)#")).toMatch(/Invalid input/);
    expect(findCliError("SW1(config)# no vlan 1\nERROR: VLAN 1 cannot be deleted\n")).toMatch(/ERROR/);
    expect(findCliError("SW1(config)#vlan 10\nSW1(config-vlan)#name x\nSW1(config-vlan)#exit\n[OK]\n")).toBeNull();
    expect(findCliError("")).toBeNull();
  });
});

describe("parseVlans", () => {
  it("reads names with dots and the legacy states", () => {
    const raw = [
      "VLAN Name                             Status    Ports",
      "---- -------------------------------- --------- -------------------------------",
      "1    default                          active    Gi1/0/1",
      "10   servers.lan                      active    Gi1/0/2",
      "20   old-vlan                         suspended",
      "1002 fddi-default                     act/unsup",
    ].join("\n");
    const rows = parseVlans(raw);
    expect(rows.map((r) => [r.vlanId, r.vlanName, r.vlanStatus])).toEqual([
      [1, "default", "active"],
      [10, "servers.lan", "active"],
      [20, "old-vlan", "suspended"],
      [1002, "fddi-default", "active"],
    ]);
  });
});
