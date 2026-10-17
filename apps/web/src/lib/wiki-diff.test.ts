import { describe, expect, it } from "vitest";
import { buildDiff, collapseUnchanged } from "./wiki-diff";

describe("buildDiff", () => {
  it("is empty and unchanged for identical text", () => {
    const d = buildDiff("a\nb\n", "a\nb\n");
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
    expect(d.rows.map((r) => r.kind)).toEqual(["same", "same"]);
    expect(d.rows[1]).toMatchObject({ oldNo: 2, newNo: 2 });
  });

  it("shows a first version as all additions", () => {
    const d = buildDiff("", "one\ntwo");
    expect(d).toMatchObject({ added: 2, removed: 0 });
    expect(d.rows.every((r) => r.kind === "add")).toBe(true);
    expect(d.rows[1]).toMatchObject({ newNo: 2, oldNo: null });
  });

  it("marks only the changed words inside an edited line", () => {
    const d = buildDiff("Restart the router now.\nDone.", "Restart the switch now.\nDone.");
    const remove = d.rows.find((r) => r.kind === "remove");
    const add = d.rows.find((r) => r.kind === "add");
    expect(remove && "segments" in remove ? remove.segments.filter((s) => s.changed).map((s) => s.text) : []).toEqual(["router"]);
    expect(add && "segments" in add ? add.segments.filter((s) => s.changed).map((s) => s.text) : []).toEqual(["switch"]);
    expect(d).toMatchObject({ added: 1, removed: 1 });
  });

  it("keeps line numbers for each side through additions and removals", () => {
    const d = buildDiff("a\nb\nc", "a\nc\nd");
    expect(d.rows.map((r) => `${r.kind}:${r.oldNo ?? "-"}:${r.newNo ?? "-"}`)).toEqual([
      "same:1:1",
      "remove:2:-",
      "same:3:2",
      "add:-:3",
    ]);
  });

  it("treats a longer replacement block as paired lines plus plain additions", () => {
    const d = buildDiff("x\n", "y\nz\n");
    expect(d.rows.map((r) => r.kind)).toEqual(["remove", "add", "add"]);
    expect(d).toMatchObject({ added: 2, removed: 1 });
  });
});

describe("collapseUnchanged", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("folds a long unchanged stretch and keeps the context around a change", () => {
    const from = lines(30);
    const to = from.replace("line 15", "line fifteen");
    const items = collapseUnchanged(buildDiff(from, to).rows, 3);
    const gaps = items.filter((i) => i.type === "gap");
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toMatchObject({ type: "gap" });
    const shown = items.filter((i) => i.type === "row").length;
    expect(shown).toBe(3 + 2 + 3);
    expect(gaps.reduce((n, g) => n + (g.type === "gap" ? g.rows.length : 0), 0)).toBe(30 - 3 - 3 - 1);
  });

  it("does not hide one or two lines", () => {
    const from = "a\nb\nc\nd\ne\nf\ng\nh\ni";
    const to = "A\nb\nc\nd\ne\nf\ng\nh\nI";
    const items = collapseUnchanged(buildDiff(from, to).rows, 3);
    expect(items.some((i) => i.type === "gap")).toBe(false);
  });

  it("returns nothing for no rows", () => {
    expect(collapseUnchanged([], 3)).toEqual([]);
  });
});

describe("buildDiff and the last line", () => {
  it("does not report a change when only the final newline differs", () => {
    const d = buildDiff("a\nb", "a\nb\n");
    expect(d).toMatchObject({ added: 0, removed: 0 });
  });
});
