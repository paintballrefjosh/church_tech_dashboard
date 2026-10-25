import { describe, expect, it } from "vitest";
import type { SwitchModel } from "@church/shared";
import { choiceToDevice, choiceToInput, currentChoice, installedModules, layoutFromSwitchModel, matchSwitchModel, matchSwitchModelDetail, resolveSwitchView, switchViewSentence } from "./custom";
import { slotForPort } from "./layouts";

const ID = "3f2b8c1e-0a4d-4e57-9b1c-5d6e7f8a9b0c";
const IMG = "7d1c1e57-1111-4e57-9b1c-5d6e7f8a9b0c";
const NOW = "2026-10-19T00:00:00.000Z";

const model = (over: Partial<SwitchModel> = {}): SwitchModel => ({
  id: ID,
  name: "Catalyst 3850-48",
  kind: "switch",
  match: ["C3850-48"],
  portSide: "front",
  frontImageId: IMG,
  backImageId: null,
  frontWidth: 2000,
  frontHeight: 200,
  backWidth: null,
  backHeight: null,
  ports: [
    { name: "Gi1/0/1", aliases: [], kind: "rj45", x: 0.1, y: 0.2, w: 0.02, h: 0.3 },
    { name: "Gi1/1/1", aliases: ["Te1/1/1"], kind: "sfp", x: 0.8, y: 0.2, w: 0.03, h: 0.3 },
  ],
  modules: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe("matchSwitchModel", () => {
  it("matches a device model containing one of the strings, in any case", () => {
    expect(matchSwitchModel([model()], "WS-C3850-48F-E")?.id).toBe(ID);
    expect(matchSwitchModel([model({ match: ["c3850-48"] })], "ws-c3850-48f-e")?.id).toBe(ID);
    expect(matchSwitchModel([model()], "WS-C3750X-48PF-S")).toBeNull();
    expect(matchSwitchModel([model()], null)).toBeNull();
    expect(matchSwitchModel([model({ match: [] })], "WS-C3850-48F-E")).toBeNull();
  });

  it("prefers the longest matching string, then the first by name", () => {
    const general = model({ id: "a", name: "Any 3850", match: ["C3850"] });
    const specific = model({ id: "b", name: "3850 PoE+", match: ["C3850-48F"] });
    expect(matchSwitchModel([general, specific], "WS-C3850-48F-E")?.id).toBe("b");
    expect(matchSwitchModel([general, specific], "WS-C3850-24T-E")?.id).toBe("a");
    const twinA = model({ id: "x", name: "A", match: ["C3850"] });
    const twinB = model({ id: "y", name: "B", match: ["C3850"] });
    expect(matchSwitchModel([twinB, twinA], "WS-C3850-24T")?.id).toBe("x");
  });
});

describe("layoutFromSwitchModel", () => {
  it("scales fractions to the picture's proportions and maps names and aliases to slots", () => {
    const l = layoutFromSwitchModel(model())!;
    expect(l.source).toBe("custom");
    expect(l.width).toBe(1000);
    expect(l.height).toBe(100); // 2000 x 200
    expect(l.image).toBe(`/api/switch-models/${ID}/images/front?v=${IMG}`);
    const gi = l.ports.find((p) => p.key === "Gi1/0/1")!;
    expect(gi).toMatchObject({ x: 100, y: 20, w: 20, h: 30 });
    expect(slotForPort("Gi1/0/1", l)).toBe("Gi1/0/1");
    expect(slotForPort("gi1/0/1", l)).toBe("Gi1/0/1");
    expect(slotForPort("Te1/1/1", l)).toBe("Gi1/1/1");
    expect(slotForPort("Gi1/0/2", l)).toBeNull();
  });

  it("offers the other side's picture when there is one", () => {
    const back = "9a9a9a9a-1111-4e57-9b1c-5d6e7f8a9b0c";
    const l = layoutFromSwitchModel(model({ backImageId: back, backWidth: 1800, backHeight: 190 }))!;
    expect(l.otherImage).toEqual({ side: "back", url: `/api/switch-models/${ID}/images/back?v=${back}`, width: 1800, height: 190 });
    expect(layoutFromSwitchModel(model())!.otherImage).toBeUndefined();
  });

  it("draws from the back when that is the port side", () => {
    const back = "9a9a9a9a-1111-4e57-9b1c-5d6e7f8a9b0c";
    const l = layoutFromSwitchModel(model({ portSide: "back", frontImageId: IMG, backImageId: back, backWidth: 1000, backHeight: 500 }))!;
    expect(l.image).toContain("/images/back?");
    expect(l.height).toBe(500);
    expect(l.otherImage?.side).toBe("front");
  });

  it("cannot be drawn without a picture on the port side or without ports", () => {
    expect(layoutFromSwitchModel(model({ frontImageId: null }))).toBeNull();
    expect(layoutFromSwitchModel(model({ portSide: "back" }))).toBeNull();
    expect(layoutFromSwitchModel(model({ ports: [] }))).toBeNull();
  });
});

describe("matchSwitchModelDetail", () => {
  it("says which string caught the text, as the admin typed it", () => {
    const hit = matchSwitchModelDetail([model({ match: [" c3850-48 ", "XYZ"] })], "WS-C3850-48F-E");
    expect(hit?.model.id).toBe(ID);
    expect(hit?.matched).toBe("c3850-48");
    expect(matchSwitchModelDetail([model()], "WS-C3750X-48")).toBeNull();
  });

  it("reports the longest string when several of one model match", () => {
    expect(matchSwitchModelDetail([model({ match: ["C3850", "C3850-48F"] })], "WS-C3850-48F-E")?.matched).toBe("C3850-48F");
  });
});

describe("currentChoice and switchViewSentence", () => {
  it("reads the saved choice off the switch", () => {
    expect(currentChoice([model()], {})).toBe("auto");
    expect(currentChoice([model()], { switchModelId: ID })).toBe(`model:${ID}`);
    expect(currentChoice([model()], { switchModelId: "9c9c9c9c-1111-4e57-9b1c-5d6e7f8a9b0c" })).toBe("auto");
    expect(currentChoice([model()], { switchModelId: ID, switchViewOff: true })).toBe("off");
  });

  it("turns a picker value into what the API takes and what the resolver reads", () => {
    expect(choiceToInput("auto")).toEqual({ mode: "auto" });
    expect(choiceToInput("off")).toEqual({ mode: "off" });
    expect(choiceToInput(`model:${ID}`)).toEqual({ mode: "model", modelId: ID });
    expect(choiceToInput("garbage")).toEqual({ mode: "auto" });
    expect(choiceToDevice("auto")).toEqual({ switchModelId: null, switchViewOff: false });
    expect(choiceToDevice("off")).toEqual({ switchModelId: null, switchViewOff: true });
    expect(choiceToDevice(`model:${ID}`)).toEqual({ switchModelId: ID, switchViewOff: false });
  });

  it("says where the picture came from", () => {
    const text = (models: SwitchModel[], dev: Parameters<typeof resolveSwitchView>[1]) =>
      switchViewSentence(resolveSwitchView(models, dev), dev.model ?? null);
    expect(text([model()], { model: "WS-C3850-48F-E" })).toBe('Switch view: Catalyst 3850-48, matched on "C3850-48" in the model text WS-C3850-48F-E.');
    expect(text([model()], { model: "X", switchModelId: ID })).toBe("Switch view: Catalyst 3850-48, chosen for this switch.");
    expect(text([model()], { model: "X", switchViewOff: true })).toContain("turned off");
    expect(text([], { model: "N3K-C9999" })).toBe('No device profile matches "N3K-C9999", so this switch\'s ports are listed only.');
    expect(text([], { model: null })).toContain("has not reported its model");
    expect(text([model({ ports: [] })], { model: "WS-C3850-48F-E" })).toContain("has no port layout yet, so the built-in drawing");
    expect(text([], { model: "WS-C3850-48F-E" })).toContain("No device profile matches");
  });
});

describe("resolveSwitchView", () => {
  const other = model({ id: "2e2e2e2e-1111-4e57-9b1c-5d6e7f8a9b0c", name: "Spare", match: [] });
  const undrawable = model({ id: "3d3d3d3d-1111-4e57-9b1c-5d6e7f8a9b0c", name: "No ports yet", match: [], ports: [] });

  it("matches on the model text when nothing was chosen, and says which string did", () => {
    const v = resolveSwitchView([model()], { model: "WS-C3850-48F-E" });
    expect(v).toMatchObject({ how: "matched", matched: "C3850-48" });
    expect(v.model?.id).toBe(ID);
    expect(v.layout?.source).toBe("custom");
  });

  it("an admin's pick beats the text match", () => {
    const v = resolveSwitchView([model(), other], { model: "WS-C3850-48F-E", switchModelId: other.id });
    expect(v.how).toBe("chosen");
    expect(v.model?.id).toBe(other.id);
    expect(v.matched).toBeNull();
    expect(v.layout?.modelId).toBe(other.id);
  });

  it("turning the view off beats everything and draws nothing", () => {
    const v = resolveSwitchView([model()], { model: "WS-C3850-48F-E", switchModelId: ID, switchViewOff: true });
    expect(v).toEqual({ how: "off", model: null, matched: null, layout: null });
  });

  it("a pick that cannot be drawn draws nothing, not something else", () => {
    const v = resolveSwitchView([model(), undrawable], { model: "WS-C3850-48F-E", switchModelId: undrawable.id });
    expect(v.how).toBe("chosen");
    expect(v.layout).toBeNull();
  });

  it("a pick of a model that is gone counts as no pick", () => {
    const v = resolveSwitchView([model()], { model: "WS-C3850-48F-E", switchModelId: "9c9c9c9c-1111-4e57-9b1c-5d6e7f8a9b0c" });
    expect(v.how).toBe("matched");
  });

  it("a matched model that cannot be drawn yet falls back to the built-in drawing for the device, if there is one", () => {
    const v = resolveSwitchView([model({ ports: [] })], { model: "WS-C3850-48F-E" });
    expect(v.how).toBe("matched");
    expect(v.layout).not.toBeNull();
    expect(v.layout?.source).not.toBe("custom");
    const v2 = resolveSwitchView([model({ ports: [], match: ["ABC"] })], { model: "ABC-1" });
    expect(v2.layout).toBeNull();
  });

  it("with no match it uses the built-in drawing, or nothing", () => {
    const builtin = resolveSwitchView([], { model: "WS-C3850-48F-E" });
    expect(builtin).toMatchObject({ how: "none", model: null, matched: null });
    expect(builtin.layout).not.toBeNull();
    expect(builtin.layout?.source).not.toBe("custom");
    expect(resolveSwitchView([], { model: "SOMETHING-ELSE" })).toEqual({ how: "none", model: null, matched: null, layout: null });
    expect(resolveSwitchView([], { model: null })).toEqual({ how: "none", model: null, matched: null, layout: null });
  });
});

describe("add-on modules", () => {
  const MOD_ID = "5a5a5a5a-1111-4e57-9b1c-5d6e7f8a9b0c";
  const MOD_IMG = "6b6b6b6b-1111-4e57-9b1c-5d6e7f8a9b0c";
  const module10g = (over: Partial<SwitchModel> = {}): SwitchModel =>
    model({
      id: MOD_ID,
      name: "C3KX-NM-10G",
      kind: "module",
      match: [],
      frontImageId: MOD_IMG,
      frontWidth: 400,
      frontHeight: 200,
      ports: [
        { name: "Te1/1/1", aliases: ["Gi1/1/1"], kind: "sfp", x: 0.1, y: 0.25, w: 0.2, h: 0.5 },
        { name: "Te1/1/2", aliases: [], kind: "sfp", x: 0.6, y: 0.25, w: 0.2, h: 0.5 },
      ],
      ...over,
    });
  // the module's box is the right-hand fifth of the switch's picture, half its height
  const placed = { id: "m1", moduleId: MOD_ID, x: 0.8, y: 0.25, w: 0.2, h: 0.5 };
  const host = (over: Partial<SwitchModel> = {}): SwitchModel => model({ modules: [placed], ports: [model().ports[0]!], ...over });

  it("puts the module's picture and ports on the host, scaled into the box it was placed in", () => {
    const layout = layoutFromSwitchModel(host(), [host(), module10g()])!;
    expect(layout.overlays).toEqual([
      { id: "m1", label: "C3KX-NM-10G", url: `/api/switch-models/${MOD_ID}/images/front?v=${MOD_IMG}`, x: 800, y: 25, w: 200, h: 50 },
    ]);
    const port = layout.ports.find((p) => p.key === "m1/Te1/1/1")!;
    expect(port).toMatchObject({ group: "m1", kind: "sfp" });
    // 0.1 across a box that starts at 0.8 and is 0.2 wide: 0.82 of 1000 units; the same for height (host is 1000 x 100)
    expect(port.x).toBeCloseTo(820);
    expect(port.w).toBeCloseTo(40);
    expect(port.y).toBeCloseTo((0.25 + 0.25 * 0.5) * 100);
    expect(port.h).toBeCloseTo(0.5 * 0.5 * 100);
  });

  it("maps the module's names and aliases to its ports, and the host keeps a name it already has", () => {
    const layout = layoutFromSwitchModel(host(), [host(), module10g()])!;
    expect(slotForPort("Te1/1/1", layout)).toBe("m1/Te1/1/1");
    expect(slotForPort("gi1/1/1", layout)).toBe("m1/Te1/1/1");
    expect(slotForPort("Gi1/0/1", layout)).toBe("Gi1/0/1");
    const withClash = host({ ports: [...model().ports] }); // the host owns Gi1/1/1 (alias Te1/1/1) too
    const layout2 = layoutFromSwitchModel(withClash, [withClash, module10g()])!;
    expect(slotForPort("Te1/1/1", layout2)).toBe("Gi1/1/1");
    expect(slotForPort("Te1/1/2", layout2)).toBe("m1/Te1/1/2");
  });

  it("leaves out a module that was deleted, has no picture, or has no ports", () => {
    expect(layoutFromSwitchModel(host(), [host()])!.overlays).toBeUndefined();
    expect(layoutFromSwitchModel(host(), [host(), module10g({ frontImageId: null })])!.overlays).toBeUndefined();
    expect(layoutFromSwitchModel(host(), [host(), module10g({ ports: [] })])!.overlays).toBeUndefined();
    // a switch model is not a module, whatever the placement points at
    expect(layoutFromSwitchModel(host(), [host(), module10g({ kind: "switch" })])!.overlays).toBeUndefined();
  });

  it("a module is never matched to a switch or offered as a pick", () => {
    const m = module10g({ match: ["C3KX-NM-10G"] });
    expect(matchSwitchModel([m], "C3KX-NM-10G")).toBeNull();
    expect(currentChoice([m], { switchModelId: MOD_ID })).toBe("auto");
    expect(resolveSwitchView([m], { model: "C3KX-NM-10G", switchModelId: MOD_ID }).how).toBe("none");
  });

  it("installedModules: a module counts while the switch reports one of its ports, by name or alias", () => {
    const all = [host(), module10g()];
    const got = installedModules(host(), all, ["Gi1/0/1", "gi1/1/1"]);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ id: "m1", label: "C3KX-NM-10G", x: 0.8, y: 0.25, w: 0.2, h: 0.5 });
    // the module's port boxes are fractions of the host's picture: 0.8 + 0.1 * 0.2
    expect(got[0]!.ports[0]).toMatchObject({ name: "Te1/1/1" });
    expect(got[0]!.ports[0]!.x).toBeCloseTo(0.82);
    expect(got[0]!.ports[0]!.w).toBeCloseTo(0.04);
    expect(installedModules(host(), all, ["Te1/1/2"])).toHaveLength(1);
  });

  it("installedModules: none when the switch lacks the module's ports, has no ports, or the module cannot be drawn", () => {
    const all = [host(), module10g()];
    expect(installedModules(host(), all, ["Gi1/0/1", "Gi1/0/2"])).toEqual([]);
    expect(installedModules(host(), all, [])).toEqual([]);
    expect(installedModules(host(), [host()], ["Te1/1/1"])).toEqual([]);
    expect(installedModules(host(), [host(), module10g({ frontImageId: null })], ["Te1/1/1"])).toEqual([]);
    expect(installedModules(model(), [model(), module10g()], ["Te1/1/1"])).toEqual([]);
  });

  it("a layout with no modules has none of the extras", () => {
    const layout = layoutFromSwitchModel(model(), [model()])!;
    expect(layout.overlays).toBeUndefined();
    expect(layout.ports.every((p) => p.group === undefined)).toBe(true);
  });

  it("works through resolveSwitchView, which passes every model on", () => {
    const h = host();
    const v = resolveSwitchView([h, module10g()], { model: "WS-C3850-48F-E" });
    expect(v.how).toBe("matched");
    expect(v.layout?.overlays?.length).toBe(1);
  });
});
