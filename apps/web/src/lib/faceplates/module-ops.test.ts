import { describe, expect, it } from "vitest";
import type { SwitchModel, SwitchModelModule } from "@church/shared";
import { defaultPlacement, heightFor, moduleSize, moveTo, newPlacementId, nameClashes, nudge, resizeTo } from "./module-ops";

const HOST = { w: 2000, h: 200 };
const MOD = { w: 400, h: 200 };
const NOW = "2026-10-19T00:00:00.000Z";

const port = (name: string, aliases: string[] = []) => ({ name, aliases, kind: "sfp" as const, x: 0.1, y: 0.1, w: 0.1, h: 0.1 });
const model = (over: Partial<SwitchModel>): SwitchModel => ({
  id: "id",
  name: "name",
  kind: "switch",
  match: [],
  portSide: "front",
  frontImageId: "img",
  backImageId: null,
  frontWidth: 400,
  frontHeight: 200,
  backWidth: null,
  backHeight: null,
  ports: [],
  modules: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const inside = (p: SwitchModelModule) => p.x >= 0 && p.y >= 0 && p.x + p.w <= 1.000001 && p.y + p.h <= 1.000001;

describe("placing a module", () => {
  it("keeps the module picture's proportions in the host's units", () => {
    // a 2:1 module picture, 0.1 of a 10:1 host's width: it is 200 x 100 px on a 2000 x 200 picture, so half the height
    expect(heightFor(0.1, HOST, MOD)).toBeCloseTo(0.5);
    expect(heightFor(0.2, { w: 1000, h: 1000 }, MOD)).toBeCloseTo(0.1);
  });

  it("reads the module's port-side size, and says when there is none", () => {
    expect(moduleSize(model({ frontWidth: 300, frontHeight: 100 }))).toEqual({ w: 300, h: 100 });
    expect(moduleSize(model({ portSide: "back" }))).toBeNull();
  });

  it("starts a new placement inside the picture, with the next free key", () => {
    const first = defaultPlacement("m", [], HOST, MOD);
    expect(first.id).toBe("m1");
    expect(inside(first)).toBe(true);
    expect(first.h).toBeCloseTo(heightFor(first.w, HOST, MOD));
    expect(defaultPlacement("m", [first], HOST, MOD).id).toBe("m2");
    expect(newPlacementId([{ ...first, id: "m2" }])).toBe("m1");
  });

  it("clamps a move to the picture", () => {
    const p = defaultPlacement("m", [], HOST, MOD);
    expect(inside(moveTo(p, -5, -5, HOST, MOD))).toBe(true);
    expect(moveTo(p, 9, 9, HOST, MOD).x).toBeCloseTo(1 - p.w);
    expect(moveTo(p, 0.3, 0.2, HOST, MOD)).toMatchObject({ x: 0.3, y: 0.2 });
  });

  it("nudges by a small step, a bigger one with Shift", () => {
    const p = moveTo(defaultPlacement("m", [], HOST, MOD), 0.4, 0.2, HOST, MOD);
    expect(nudge(p, 1, 0, false, HOST, MOD).x).toBeCloseTo(0.402);
    expect(nudge(p, -1, 0, true, HOST, MOD).x).toBeCloseTo(0.39);
  });

  it("resizes by width, keeping the proportions and staying inside", () => {
    const p = moveTo(defaultPlacement("m", [], HOST, MOD), 0.5, 0.1, HOST, MOD);
    const bigger = resizeTo(p, 0.2, HOST, MOD);
    expect(bigger.w).toBeCloseTo(0.2);
    expect(bigger.h).toBeCloseTo(heightFor(0.2, HOST, MOD));
    // far too wide: held to what fits, not past the edge
    const huge = resizeTo(p, 5, HOST, MOD);
    expect(inside(huge)).toBe(true);
    expect(resizeTo(p, 0, HOST, MOD).w).toBeGreaterThan(0);
  });
});

describe("nameClashes", () => {
  const mod = model({ id: "mod", name: "NM-10G", kind: "module", ports: [port("Te1/1/1", ["Gi1/1/1"]), port("Te1/1/2")] });
  const at = (id: string): SwitchModelModule => ({ id, moduleId: "mod", x: 0.5, y: 0.1, w: 0.2, h: 0.4 });

  it("is quiet when every name is used once", () => {
    const host = model({ ports: [port("Gi1/0/1")], modules: [at("m1")] });
    expect(nameClashes(host, [host, mod])).toEqual([]);
  });

  it("names a port the host already has", () => {
    const host = model({ name: "3750X", ports: [port("Gi1/1/1")], modules: [at("m1")] });
    const out = nameClashes(host, [host, mod]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("Gi1/1/1");
    expect(out[0]).toContain("3750X");
  });

  it("names a module placed twice, once per name", () => {
    const host = model({ ports: [], modules: [at("m1"), at("m2")] });
    const out = nameClashes(host, [host, mod]);
    // Te1/1/1, its alias Gi1/1/1 and Te1/1/2 all come up a second time
    expect(out).toHaveLength(3);
  });

  it("ignores a placement whose module is gone", () => {
    const host = model({ modules: [at("m1")] });
    expect(nameClashes(host, [host])).toEqual([]);
  });
});
