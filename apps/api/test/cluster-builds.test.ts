import { describe, expect, it } from "vitest";
import { checkBuilds } from "@church/shared";

const n = (id: string, version: string | null, live = true) => ({ id, version, live });

describe("checkBuilds", () => {
  it("is quiet when every live node runs the same build", () => {
    const r = checkBuilds([n("a", "abc"), n("b", "abc"), n("c", "abc")]);
    expect(r.mismatch).toBe(false);
    expect([...r.odd]).toEqual([]);
  });

  it("flags the node that differs from the majority", () => {
    const r = checkBuilds([n("a", "new"), n("b", "new"), n("c", "old")]);
    expect(r.mismatch).toBe(true);
    expect(r.reference).toBe("new");
    expect([...r.odd]).toEqual(["c"]);
  });

  it("flags every node of the minority builds", () => {
    const r = checkBuilds([n("a", "x"), n("b", "x"), n("c", "y"), n("d", "z")]);
    expect(r.reference).toBe("x");
    expect([...r.odd].sort()).toEqual(["c", "d"]);
  });

  it("flags everyone when there is no majority (two nodes, two builds)", () => {
    const r = checkBuilds([n("a", "x"), n("b", "y")]);
    expect(r.mismatch).toBe(true);
    expect(r.reference).toBeNull();
    expect([...r.odd].sort()).toEqual(["a", "b"]);
  });

  it("ignores a node that stopped heartbeating", () => {
    const r = checkBuilds([n("a", "new"), n("b", "new"), n("c", "old", false)]);
    expect(r.mismatch).toBe(false);
  });

  it("treats a live node that reports no build as a different one, unless none do", () => {
    expect(checkBuilds([n("a", "x"), n("b", "x"), n("c", null)]).odd.has("c")).toBe(true);
    expect(checkBuilds([n("a", null), n("b", null)]).mismatch).toBe(false);
  });

  it("a single node cannot mismatch", () => {
    expect(checkBuilds([n("a", "x")]).mismatch).toBe(false);
    expect(checkBuilds([]).mismatch).toBe(false);
  });
});
