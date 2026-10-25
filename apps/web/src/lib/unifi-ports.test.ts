import { describe, expect, it } from "vitest";
import type { FaceplateLayout } from "./faceplates/layouts";
import { clientsByPort, portDescription, speedText, unifiFaceItems, unifiPoeText, unifiPortState } from "./unifi-ports";

const custom = (names: Record<string, string>): FaceplateLayout => ({ source: "custom", names, ports: [] }) as unknown as FaceplateLayout;

describe("UniFi ports on the switch view", () => {
  it("reads link state, speed and a port switched off by its profile", () => {
    expect(unifiPortState({ port_idx: 1, up: true, speed: 1000, full_duplex: true })).toEqual({ state: "up", text: "up, 1 Gbps" });
    expect(unifiPortState({ port_idx: 2, up: true, speed: 100, full_duplex: false })).toEqual({ state: "up", text: "up, 100 Mbps half duplex" });
    expect(unifiPortState({ port_idx: 3, up: false })).toEqual({ state: "down", text: "no link" });
    expect(unifiPortState({ port_idx: 4, up: true, enable: false })).toEqual({ state: "shut", text: "disabled" });
    expect(speedText(2500)).toBe("2.5 Gbps");
  });

  it("shows PoE only while the port is drawing power", () => {
    expect(unifiPoeText({ poe_enable: true, poe_power: "4.21" })).toBe("PoE, 4.2 W");
    expect(unifiPoeText({ poe_enable: true, poe_power: "0.00" })).toBeUndefined();
    expect(unifiPoeText({ poe_enable: false, poe_power: "4" })).toBeUndefined();
  });

  it("treats the controller's default name as no description", () => {
    expect(portDescription({ port_idx: 7, name: "Port 7" })).toBe("");
    expect(portDescription({ port_idx: 7, name: "Sound desk" })).toBe("Sound desk");
  });

  it("places ports by number or by their own name, each slot once, never on a built-in drawing", () => {
    const ports = [{ port_idx: 2, name: "Port 2" }, { port_idx: 1, name: "Port 1" }, { port_idx: 25, name: "SFP+ 1" }, { port_idx: 26, name: "Port 26" }];
    const items = unifiFaceItems(ports, custom({ "1": "s1", "2": "s2", "sfp+ 1": "sfp1", "26": "s2" }));
    expect(items.map((i) => [i.label, i.slot])).toEqual([["1", "s1"], ["2", "s2"], ["25", "sfp1"], ["26", null]]);
    expect(unifiFaceItems(ports, { source: "builtin", ports: [] } as unknown as FaceplateLayout).every((i) => i.slot === null)).toBe(true);
  });

  it("finds the wired clients on each port of this switch only", () => {
    const map = clientsByPort(
      [
        { name: "Desk", is_wired: true, sw_mac: "AA:BB:CC:00:00:01", sw_port: 3 },
        { name: "Phone", is_wired: false, sw_mac: "aa:bb:cc:00:00:01", sw_port: 3 },
        { name: "Other switch", is_wired: true, sw_mac: "aa:bb:cc:00:00:02", sw_port: 3 },
      ],
      "aa:bb:cc:00:00:01",
    );
    expect([...map.keys()]).toEqual([3]);
    expect(map.get(3)!.map((c) => c.name)).toEqual(["Desk"]);
  });
});
