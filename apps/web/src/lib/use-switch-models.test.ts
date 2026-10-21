import { describe, expect, it } from "vitest";
import type { SwitchModel } from "@church/shared";
import { normaliseModel } from "./use-switch-models";

const NOW = "2026-10-19T00:00:00.000Z";
const base = {
  id: "3f2b8c1e-0a4d-4e57-9b1c-5d6e7f8a9b0c",
  name: "Catalyst 3850",
  match: [],
  portSide: "front",
  frontImageId: null,
  backImageId: null,
  frontWidth: null,
  frontHeight: null,
  backWidth: null,
  backHeight: null,
  ports: [],
  createdAt: NOW,
  updatedAt: NOW,
};

describe("normaliseModel", () => {
  it("treats a model from an API that has not been upgraded as a switch with no modules", () => {
    const old = base as unknown as SwitchModel; // no kind, no modules: what the previous release sends
    expect(normaliseModel(old)).toMatchObject({ kind: "switch", modules: [] });
  });

  it("keeps a module's kind and a model's placements", () => {
    const placed = [{ id: "m1", moduleId: "5a5a5a5a-1111-4e57-9b1c-5d6e7f8a9b0c", x: 0.7, y: 0.2, w: 0.2, h: 0.5 }];
    expect(normaliseModel({ ...base, kind: "module", modules: [] } as unknown as SwitchModel).kind).toBe("module");
    expect(normaliseModel({ ...base, kind: "switch", modules: placed } as unknown as SwitchModel).modules).toEqual(placed);
  });
});
