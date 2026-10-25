import { describe, expect, it } from "vitest";
import {
  createRackItemSchema,
  createRackSchema,
  findConflict,
  firstFreeSlot,
  fitsCabinet,
  pictureFitsSlot,
  placementProblem,
  rackRows,
  suggestHeightU,
  topU,
  usedUnits,
} from "@church/shared";

const item = (id: string, startU: number, heightU: number, label = id) => ({ id, startU, heightU, label });

describe("cabinet placement", () => {
  it("counts U from the bottom: start 10, height 2 fills U10 and U11", () => {
    expect(topU({ startU: 10, heightU: 2 })).toBe(11);
    expect(topU({ startU: 1, heightU: 1 })).toBe(1);
  });

  it("fits only inside the cabinet", () => {
    expect(fitsCabinet(42, { startU: 41, heightU: 2 })).toBe(true);
    expect(fitsCabinet(42, { startU: 42, heightU: 2 })).toBe(false);
    expect(fitsCabinet(42, { startU: 0, heightU: 1 })).toBe(false);
    expect(fitsCabinet(42, { startU: 1, heightU: 0 })).toBe(false);
    expect(fitsCabinet(42, { startU: 1.5, heightU: 1 })).toBe(false);
  });

  it("finds an overlap at either end and in the middle, and ignores the item being moved", () => {
    const items = [item("a", 10, 4)]; // U10-U13
    expect(findConflict(items, { startU: 13, heightU: 2 })?.id).toBe("a");
    expect(findConflict(items, { startU: 8, heightU: 3 })?.id).toBe("a");
    expect(findConflict(items, { startU: 11, heightU: 1 })?.id).toBe("a");
    expect(findConflict(items, { startU: 14, heightU: 1 })).toBeNull();
    expect(findConflict(items, { startU: 9, heightU: 1 })).toBeNull();
    expect(findConflict(items, { startU: 10, heightU: 4 }, "a")).toBeNull();
  });

  it("explains a refusal in words", () => {
    const items = [item("sw", 10, 2, "core-sw")];
    expect(placementProblem(42, items, { startU: 41, heightU: 3 })).toMatch(/does not fit.*U43.*42U/);
    expect(placementProblem(42, items, { startU: 11, heightU: 1 })).toMatch(/U11 is already taken.*core-sw.*U10-U11/);
    expect(placementProblem(42, items, { startU: 12, heightU: 1 })).toBeNull();
  });

  it("finds the lowest free run that is tall enough", () => {
    const items = [item("a", 1, 2), item("b", 4, 1), item("c", 6, 5)];
    expect(firstFreeSlot(42, items, 1)).toBe(3);
    expect(firstFreeSlot(42, items, 2)).toBe(11);
    expect(firstFreeSlot(11, items, 2)).toBeNull();
    expect(firstFreeSlot(4, [], 4)).toBe(1);
    expect(firstFreeSlot(4, [], 5)).toBeNull();
  });

  it("lists the cabinet from the top down, every free U as a row", () => {
    const rows = rackRows(6, [item("a", 2, 2), item("b", 6, 1)]);
    expect(rows.map((r) => (r.kind === "item" ? `${r.item.id}@${r.topU}` : `.${r.topU}`))).toEqual(["b@6", ".5", ".4", "a@3", ".1"]);
  });

  it("still lists an item that reaches past the top of a shrunken cabinet", () => {
    const rows = rackRows(4, [item("tall", 3, 4)]);
    expect(rows[0]).toMatchObject({ kind: "item", topU: 6 });
    expect(rows.filter((r) => r.kind === "item")).toHaveLength(1);
  });

  it("counts used units", () => {
    expect(usedUnits([item("a", 1, 2), item("b", 5, 3)])).toBe(5);
    expect(usedUnits([])).toBe(0);
  });
});

describe("picture proportions", () => {
  it("suggests the U height from the picture", () => {
    // 1U: 482.6 x 44.45
    expect(suggestHeightU(4826, 444)).toBe(1);
    expect(suggestHeightU(4826, 889)).toBe(2);
    expect(suggestHeightU(4826, 1778)).toBe(4);
    expect(suggestHeightU(null, null)).toBe(1);
    expect(suggestHeightU(100, 100000, 42)).toBe(42);
  });

  it("stretches a picture only when its proportions are near the slot's", () => {
    expect(pictureFitsSlot(4826, 444, 1)).toBe(true);
    expect(pictureFitsSlot(4826, 500, 1)).toBe(true); // 12% off
    expect(pictureFitsSlot(4826, 800, 1)).toBe(false);
    expect(pictureFitsSlot(4826, 889, 2)).toBe(true);
    expect(pictureFitsSlot(null, 10, 1)).toBe(false);
  });
});

describe("cabinet schemas", () => {
  it("defaults a cabinet to 42U and refuses a silly size", () => {
    expect(createRackSchema.parse({ name: " Server room " })).toMatchObject({ name: "Server room", units: 42, location: "" });
    expect(createRackSchema.safeParse({ name: "x", units: 0 }).success).toBe(false);
    expect(createRackSchema.safeParse({ name: "x", units: 61 }).success).toBe(false);
    expect(createRackSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("a linked item needs a device, a custom one needs a name and no device", () => {
    const place = { startU: 1, heightU: 1 };
    expect(createRackItemSchema.safeParse({ sourceKind: "cisco", ...place }).success).toBe(false);
    expect(createRackItemSchema.safeParse({ sourceKind: "cisco", sourceId: "abc", ...place }).success).toBe(true);
    expect(createRackItemSchema.safeParse({ sourceKind: "custom", ...place }).success).toBe(false);
    expect(createRackItemSchema.safeParse({ sourceKind: "custom", label: "Patch panel A", ...place }).success).toBe(true);
    expect(createRackItemSchema.safeParse({ sourceKind: "custom", label: "x", sourceId: "abc", ...place }).success).toBe(false);
  });

  it("refuses control characters in a name", () => {
    expect(createRackItemSchema.safeParse({ sourceKind: "custom", label: "bad\u0007name", startU: 1, heightU: 1 }).success).toBe(false);
  });
});
