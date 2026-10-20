import { describe, expect, it } from "vitest";
import { ciscoSlotFor, FACEPLATE_LAYOUTS, faceplateForModel } from "./layouts";

const layout = (model: string) => {
  const l = faceplateForModel(model);
  if (!l) throw new Error(`no layout for ${model}`);
  return l;
};

describe("faceplateForModel", () => {
  it("finds the fleet's three models and nothing for others", () => {
    expect(faceplateForModel("WS-C3850-48F-E")?.id).toBe("cisco-c3850-48");
    expect(faceplateForModel("WS-C3750X-48PF-S")?.id).toBe("cisco-c3750x-48");
    expect(faceplateForModel("N3K-C3064PQ-10GE")?.id).toBe("cisco-n3k-c3064pq");
    expect(faceplateForModel("WS-C2960-24TT-L")).toBeNull();
    expect(faceplateForModel(null)).toBeNull();
    expect(faceplateForModel("")).toBeNull();
  });
});

describe("layouts", () => {
  it("have unique slot keys, all inside the panel and none overlapping", () => {
    for (const l of FACEPLATE_LAYOUTS) {
      const keys = l.ports.map((p) => p.key);
      expect(new Set(keys).size, l.id).toBe(keys.length);
      for (const p of l.ports) {
        expect(p.x, `${l.id} ${p.key}`).toBeGreaterThanOrEqual(0);
        expect(p.y, `${l.id} ${p.key}`).toBeGreaterThanOrEqual(0);
        expect(p.x + p.w, `${l.id} ${p.key}`).toBeLessThanOrEqual(l.width);
        expect(p.y + p.h, `${l.id} ${p.key}`).toBeLessThanOrEqual(l.height);
      }
      for (const a of l.ports) {
        for (const b of l.ports) {
          if (a === b) continue;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart, `${l.id} ${a.key} overlaps ${b.key}`).toBe(true);
        }
      }
    }
  });

  it("number a two-row panel odd on top, even below", () => {
    const l = layout("WS-C3850-48F-E");
    const at = (k: string) => l.ports.find((p) => p.key === k)!;
    expect(at("1").y).toBeLessThan(at("2").y);
    expect(at("1").x).toBe(at("2").x);
    expect(at("3").x).toBeGreaterThan(at("1").x);
    expect(l.ports.filter((p) => !p.key.startsWith("m")).length).toBe(48);
  });
});

describe("ciscoSlotFor", () => {
  it("maps Catalyst main-board ports and both names of an uplink cage", () => {
    const l = layout("WS-C3750X-48PF-S");
    expect(ciscoSlotFor("Gi1/0/1", l)).toBe("1");
    expect(ciscoSlotFor("Gi1/0/48", l)).toBe("48");
    expect(ciscoSlotFor("Gi1/1/3", l)).toBe("m3");
    expect(ciscoSlotFor("Te1/1/3", l)).toBe("m3");
  });

  it("leaves what is not on the front out", () => {
    const l = layout("WS-C3750X-48PF-S");
    for (const id of ["Fa0", "Gi0/0", "Po10", "Vlan1", "Gi2/0/1", "Gi1/0/49", "Te1/1/5", "Gi1/2/1"]) {
      expect(ciscoSlotFor(id, l), id).toBeNull();
    }
  });

  it("maps Nexus ports and ignores port channels and breakout lanes", () => {
    const l = layout("N3K-C3064PQ-10GE");
    expect(ciscoSlotFor("Eth1/1", l)).toBe("1");
    expect(ciscoSlotFor("Eth1/52", l)).toBe("52");
    expect(ciscoSlotFor("Eth1/53", l)).toBeNull();
    expect(ciscoSlotFor("Eth1/49/1", l)).toBeNull();
    expect(ciscoSlotFor("Po20", l)).toBeNull();
  });
});
