import { describe, expect, it } from "vitest";
import { formatWatts, poeInUse, poeKind, poeProviding, poeRows, poeShortName, poeSummary } from "./poe";

const poe = (over: Partial<{ status: string; device: string | null; ieeeClass: number | null; allocatedMw: number | null; measuredMw: number | null }> = {}) => ({
  status: "on",
  device: "Ieee PD",
  ieeeClass: 4,
  allocatedMw: 25500,
  measuredMw: 8100,
  ...over,
});

describe("poeKind", () => {
  it("names the IEEE class", () => {
    expect(poeKind(0, 15400)).toBe("PoE (802.3af)");
    expect(poeKind(3, 12900)).toBe("PoE (802.3af)");
    expect(poeKind(4, 25500)).toBe("PoE+ (802.3at)");
    expect(poeKind(5, 45000)).toBe("PoE++ (802.3bt type 3)");
    expect(poeKind(6, 60000)).toBe("PoE++ (802.3bt type 3)");
    expect(poeKind(7, 75000)).toBe("PoE++ (802.3bt type 4)");
    expect(poeKind(8, 90000)).toBe("PoE++ (802.3bt type 4)");
  });

  it("goes by the power set aside when the class is unknown", () => {
    expect(poeKind(null, 7000)).toBe("PoE (802.3af)");
    expect(poeKind(null, 25500)).toBe("PoE+ (802.3at)");
    expect(poeKind(null, 60000)).toBe("PoE++ (802.3bt)");
    expect(poeKind(null, null)).toBe("PoE (802.3af)");
  });

  it("lets a device that was given more than its class implies count as the larger kind", () => {
    expect(poeKind(0, 25500)).toBe("PoE+ (802.3at)");
    expect(poeKind(2, 15400)).toBe("PoE (802.3af)");
  });

  it("has a short name", () => {
    expect(poeShortName(4, 25500)).toBe("PoE+");
    expect(poeShortName(0, 15400)).toBe("PoE");
    expect(poeShortName(6, 60000)).toBe("PoE++");
  });
});

describe("poe readings", () => {
  it("is providing only while the status is on", () => {
    expect(poeProviding(poe())).toBe(true);
    expect(poeProviding(poe({ status: "off" }))).toBe(false);
    expect(poeProviding(poe({ status: "faulty" }))).toBe(false);
    expect(poeProviding(null)).toBe(false);
    expect(poeProviding(undefined)).toBe(false);
  });

  it("formats watts", () => {
    expect(formatWatts(8100)).toBe("8.1 W");
    expect(formatWatts(0)).toBe("0.0 W");
    expect(formatWatts(null)).toBe("—");
  });

  it("describes a powered port with its kind, class, measured and reserved power and device", () => {
    expect(poeRows(poe())).toEqual([
      ["PoE", "PoE+ (802.3at) · class 4"],
      ["Power", "8.1 W in use · 25.5 W set aside"],
      ["Powered device", "Ieee PD"],
    ]);
  });

  it("copes with a switch that does not measure and a device it cannot name", () => {
    expect(poeRows(poe({ measuredMw: null, device: null, ieeeClass: null }))).toEqual([
      ["PoE", "PoE+ (802.3at)"],
      ["Power", "25.5 W set aside"],
    ]);
  });

  it("says why a port is not powering anything", () => {
    expect(poeRows(poe({ status: "off" }))).toEqual([["PoE", "no device powered"]]);
    expect(poeRows(poe({ status: "disabled" }))).toEqual([["PoE", "turned off on this port"]]);
    expect(poeRows(poe({ status: "power-deny" }))[0]![1]).toContain("denied");
    expect(poeRows(poe({ status: "tstart" }))).toEqual([["PoE", "tstart"]]);
  });

  it("has nothing to say for a port with no PoE reading", () => {
    expect(poeRows(null)).toEqual([]);
    expect(poeRows(undefined)).toEqual([]);
  });

  it("summarises for a screen reader, preferring the measured power", () => {
    expect(poeSummary(poe())).toBe("PoE+, 8.1 W");
    expect(poeSummary(poe({ measuredMw: null }))).toBe("PoE+, 25.5 W");
    expect(poeSummary(poe({ measuredMw: null, allocatedMw: null, ieeeClass: 0 }))).toBe("PoE");
  });

  it("totals what the powered ports deliver", () => {
    expect(poeInUse([{ poe: poe() }, { poe: poe({ measuredMw: 4300 }) }, { poe: poe({ status: "off", measuredMw: 0 }) }, { poe: null }])).toBe("12.4 W");
    expect(poeInUse([{ poe: null }, { poe: poe({ status: "off" }) }])).toBeNull();
    expect(poeInUse([])).toBeNull();
  });
});
