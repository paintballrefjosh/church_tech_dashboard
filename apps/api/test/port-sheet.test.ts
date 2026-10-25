import { describe, expect, it } from "vitest";
import { ciscoSheetRows, comparePortNames, unifiSheetRows, unifiSubnetCidr, type CiscoPortRow, type VlanLookup } from "@church/shared";

const lookup: VlanLookup = {
  name: (id) => ({ 10: "Staff", 20: "Voice", 99: "Mgmt" })[id] ?? null,
  subnets: (id) => ({ 10: ["10.0.10.0/24"], 20: ["10.0.20.0/24"], 99: ["10.0.99.0/24"] })[id] ?? [],
};

function port(over: Partial<CiscoPortRow>): CiscoPortRow {
  return {
    id: over.portId ?? "p",
    portId: "Gi1/0/1",
    description: "",
    adminEnabled: true,
    speed: "auto",
    duplex: "auto",
    mode: "access",
    hasSwitchport: true,
    accessVlan: 1,
    trunkNativeVlan: 1,
    trunkAllowedVlans: "1-4094",
    operStatus: "up",
    poe: null,
    neighborHostname: null,
    neighborPort: null,
    ...over,
  };
}

describe("port order", () => {
  it("reads Gi1/0/2 before Gi1/0/10", () => {
    expect(["Gi1/0/10", "Gi1/0/2", "Gi1/0/1"].sort(comparePortNames)).toEqual(["Gi1/0/1", "Gi1/0/2", "Gi1/0/10"]);
  });
});

describe("Cisco port sheet", () => {
  it("shows an access port's VLAN with its name and subnet", () => {
    const [row] = ciscoSheetRows([port({ portId: "Gi1/0/5", description: "Office PC", accessVlan: 10 })], lookup);
    expect(row).toMatchObject({ port: "Gi1/0/5", description: "Office PC", mode: "access", vlan: "10 Staff", subnet: "10.0.10.0/24", link: "up" });
  });

  it("uses a dash for a VLAN with no name or subnet, and sorts the ports", () => {
    const rows = ciscoSheetRows([port({ portId: "Gi1/0/10", accessVlan: 77 }), port({ portId: "Gi1/0/2", accessVlan: 1 })], lookup);
    expect(rows.map((r) => r.port)).toEqual(["Gi1/0/2", "Gi1/0/10"]);
    expect(rows[1]).toMatchObject({ vlan: "77", subnet: "-" });
  });

  it("describes a trunk with its native and a short tagged list", () => {
    const [row] = ciscoSheetRows([port({ mode: "trunk", trunkNativeVlan: 99, trunkAllowedVlans: "10,20,99" })], lookup);
    expect(row?.vlan).toBe("trunk, native 99 Mgmt; tagged 10 Staff, 20 Voice");
    expect(row?.subnet).toBe("99: 10.0.99.0/24; 10: 10.0.10.0/24; 20: 10.0.20.0/24");
  });

  it("summarises a trunk that carries everything or a long list", () => {
    const [all] = ciscoSheetRows([port({ mode: "trunk", trunkNativeVlan: 1, trunkAllowedVlans: "1-4094" })], lookup);
    expect(all?.vlan).toBe("trunk, native 1; all VLANs");
    const [many] = ciscoSheetRows([port({ mode: "trunk", trunkNativeVlan: 10, trunkAllowedVlans: "10,21-30" })], lookup);
    expect(many?.vlan).toBe("trunk, native 10 Staff; 10 tagged VLANs");
    expect(many?.subnet).toBe("10.0.10.0/24");
  });

  it("says routed ports are routed and shut ports are shut", () => {
    const [routed, shut] = ciscoSheetRows([port({ portId: "Gi1/0/1", hasSwitchport: false }), port({ portId: "Gi1/0/2", adminEnabled: false, operStatus: "down" })], lookup);
    expect(routed).toMatchObject({ mode: "routed", vlan: "routed" });
    expect(shut?.link).toBe("shut");
  });
});

describe("UniFi subnets", () => {
  it("turns the controller's host address into the subnet", () => {
    expect(unifiSubnetCidr("10.0.10.1/24")).toBe("10.0.10.0/24");
    expect(unifiSubnetCidr("192.168.1.254/23")).toBe("192.168.0.0/23");
    expect(unifiSubnetCidr("10.1.2.3/32")).toBe("10.1.2.3/32");
    expect(unifiSubnetCidr("")).toBeNull();
    expect(unifiSubnetCidr("junk")).toBe("junk");
  });
});

describe("UniFi port sheet", () => {
  const networks = [
    { _id: "n-def", name: "Default", ip_subnet: "192.168.1.1/24" },
    { _id: "n-staff", name: "Staff", vlan_enabled: true, vlan: 10, ip_subnet: "10.0.10.1/24" },
    { _id: "n-cam", name: "Cameras", vlan_enabled: true, vlan: "30", ip_subnet: "10.0.30.1/24" },
  ];
  const profiles = [
    { _id: "pf-all", name: "All", forward: "all", native_networkconf_id: "n-def" },
    { _id: "pf-staff", name: "Staff", forward: "native", native_networkconf_id: "n-staff" },
    { _id: "pf-ap", name: "AP", forward: "customize", native_networkconf_id: "n-def", tagged_networkconf_ids: ["n-staff", "n-cam"] },
    { _id: "pf-off", name: "Disabled", forward: "disabled" },
  ];

  it("resolves a port through its profile to a VLAN and subnet", () => {
    const rows = unifiSheetRows({ port_table: [{ port_idx: 1, name: "Port 1", up: true, portconf_id: "pf-staff" }] }, profiles, networks);
    expect(rows[0]).toMatchObject({ port: "1", description: "", mode: "access", vlan: "10 Staff (profile Staff)", subnet: "10.0.10.0/24", link: "up" });
  });

  it("a per-port override wins and its name is the description", () => {
    const rows = unifiSheetRows(
      { port_table: [{ port_idx: 2, name: "Port 2", up: false, portconf_id: "pf-all" }], port_overrides: [{ port_idx: 2, name: "Front desk", portconf_id: "pf-staff" }] },
      profiles,
      networks,
    );
    expect(rows[0]).toMatchObject({ description: "Front desk", vlan: "10 Staff (profile Staff)", link: "down" });
  });

  it("lists tagged networks for a customised profile", () => {
    const rows = unifiSheetRows({ port_table: [{ port_idx: 3, up: true, portconf_id: "pf-ap" }] }, profiles, networks);
    expect(rows[0]?.mode).toBe("trunk");
    expect(rows[0]?.vlan).toBe("Default; tagged 10 Staff, 30 Cameras (profile AP)");
    expect(rows[0]?.subnet).toBe("192.168.1.0/24; 10.0.10.0/24; 10.0.30.0/24");
  });

  it("the All profile carries every network tagged", () => {
    const rows = unifiSheetRows({ port_table: [{ port_idx: 4, up: true, portconf_id: "pf-all" }] }, profiles, networks);
    expect(rows[0]).toMatchObject({ mode: "trunk", vlan: "Default; all networks tagged", subnet: "192.168.1.0/24" });
  });

  it("shows a disabled port as disabled, and sorts by port number", () => {
    const rows = unifiSheetRows({ port_table: [{ port_idx: 10, portconf_id: "pf-off" }, { port_idx: 9, up: true, portconf_id: "pf-staff" }] }, profiles, networks);
    expect(rows.map((r) => r.port)).toEqual(["9", "10"]);
    expect(rows[1]).toMatchObject({ link: "disabled", mode: "disabled", subnet: "-" });
  });

  it("does not invent a VLAN when the profiles could not be read", () => {
    const rows = unifiSheetRows({ port_table: [{ port_idx: 1, up: true, portconf_id: "pf-staff" }] }, [], []);
    expect(rows[0]).toMatchObject({ vlan: "-", subnet: "-", link: "up" });
  });
});
