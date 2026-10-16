import { describe, expect, it } from "vitest";
import { normaliseDuplex, normaliseSpeed, speedLabel, ciscoPortInputSchema } from "@church/shared";
import { driftFieldsFor, sameValue } from "../src/cisco/cisco.poller";
import { parseRunningConfig, type CfgPort } from "../src/cisco/parsers";
import type { ciscoPorts } from "../src/db/schema";

type Desired = typeof ciscoPorts.$inferSelect;

const desired = (over: Partial<Desired> = {}): Desired => ({
  id: "p1",
  switchId: "s1",
  portId: "Gi1/0/1",
  description: "Office AP",
  adminEnabled: true,
  speed: "1000",
  duplex: "full",
  mode: "access",
  hasSwitchport: true,
  accessVlan: 10,
  trunkNativeVlan: 1,
  trunkAllowedVlans: "1-4094",
  neighborHostname: null,
  neighborIp: null,
  neighborPort: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

const observed = (over: Partial<CfgPort> = {}): CfgPort => ({
  portId: "Gi1/0/1",
  description: "Office AP",
  adminEnabled: true,
  speed: "1000",
  duplex: "full",
  mode: "access",
  hasSwitchport: true,
  accessVlan: 10,
  trunkNativeVlan: 1,
  trunkAllowedVlans: "1-4094",
  ...over,
});

/** The fields that would be recorded as drift. */
const drifted = (d: Desired, o: CfgPort) =>
  driftFieldsFor(d, o)
    .filter(([field, expected, observedValue]) => !sameValue(field, expected, observedValue))
    .map(([field]) => field);

describe("normaliseSpeed", () => {
  it("reads every way of writing a speed as the switch's Mbps number", () => {
    for (const v of ["1000", "1G", "1g", "1 Gbps", "1000 Mbps", " 1000M "]) expect(normaliseSpeed(v)).toBe("1000");
    expect(normaliseSpeed("10G")).toBe("10000");
    expect(normaliseSpeed("2.5G")).toBe("2500");
    expect(normaliseSpeed("100M")).toBe("100");
    expect(normaliseSpeed("100")).toBe("100");
  });
  it("treats blank and auto forms as auto, and keeps what it does not recognise", () => {
    for (const v of ["", "auto", "AUTO", null, undefined, "auto 10 100"]) expect(normaliseSpeed(v)).toBe("auto");
    expect(normaliseSpeed("fast")).toBe("fast");
  });
  it("labels a stored speed for people", () => {
    expect(speedLabel("1000")).toBe("1 Gbps");
    expect(speedLabel("1G")).toBe("1 Gbps");
    expect(speedLabel("auto")).toBe("Auto");
    expect(speedLabel("777")).toBe("777");
  });
});

describe("normaliseDuplex", () => {
  it("lower-cases and treats blank as auto", () => {
    expect(normaliseDuplex("Full")).toBe("full");
    expect(normaliseDuplex("")).toBe("auto");
    expect(normaliseDuplex(undefined)).toBe("auto");
  });
});

describe("port drift: description, speed and duplex", () => {
  it("is quiet when the device matches, however the speed was typed", () => {
    expect(drifted(desired(), observed())).toEqual([]);
    expect(drifted(desired({ speed: "1G" }), observed({ speed: "1000" }))).toEqual([]);
    expect(drifted(desired({ speed: "auto", duplex: "auto" }), observed({ speed: "auto", duplex: "auto" }))).toEqual([]);
  });

  it("reports each of the three fields on its own", () => {
    expect(drifted(desired(), observed({ description: "Spare" }))).toEqual(["description"]);
    expect(drifted(desired(), observed({ speed: "100" }))).toEqual(["speed"]);
    expect(drifted(desired(), observed({ duplex: "half" }))).toEqual(["duplex"]);
    expect(drifted(desired(), observed({ description: "", speed: "auto", duplex: "auto" }))).toEqual([
      "description",
      "speed",
      "duplex",
    ]);
  });

  it("records the values in the switch's own form so a push sends them as they are", () => {
    const rows = driftFieldsFor(desired({ speed: "1G" }), observed({ speed: "100" }));
    expect(rows.find(([f]) => f === "speed")).toEqual(["speed", "1000", "100"]);
  });

  it("compares a description exactly, apart from surrounding spaces", () => {
    expect(sameValue("description", "Office AP", "office ap")).toBe(false);
    expect(sameValue("description", "Office AP ", "Office AP")).toBe(true);
    expect(sameValue("admin_enabled", "1", "1")).toBe(true);
    expect(sameValue("duplex", "Full", "full")).toBe(true);
  });

  it("checks these on a routed port too, where the VLAN fields do not apply", () => {
    const routed = desired({ hasSwitchport: false });
    expect(driftFieldsFor(routed, observed({ hasSwitchport: false })).map(([f]) => f)).toEqual([
      "admin_enabled",
      "description",
      "speed",
      "duplex",
    ]);
  });

  it("agrees with what the running config parser reads from a real interface block", () => {
    const parsed = parseRunningConfig(
      ["interface GigabitEthernet1/0/1", " description Office AP", " switchport access vlan 10", " speed 1000", " duplex full", "!"].join("\n"),
    );
    const port = parsed.ports[0]!;
    expect(drifted(desired(), port)).toEqual([]);
    expect(drifted(desired({ description: "Office AP 2" }), port)).toEqual(["description"]);
  });
});

describe("port description input", () => {
  it("refuses line breaks and control characters, which would become a second switch command", () => {
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", description: "ok text" }).success).toBe(true);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", description: "a\nshutdown" }).success).toBe(false);
    expect(ciscoPortInputSchema.safeParse({ portId: "Gi1/0/1", description: "a\r" }).success).toBe(false);
  });
});
