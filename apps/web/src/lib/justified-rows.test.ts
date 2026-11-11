import { describe, expect, it } from "vitest";
import { aspectOf, justifiedRows } from "./justified-rows";

const opts = { containerWidth: 1000, targetHeight: 180, gap: 4 };
const rowWidth = (row: Array<{ width: number }>, gap: number) => row.reduce((t, b) => t + b.width, 0) + gap * (row.length - 1);

describe("justified rows", () => {
  it("fills every full row exactly to the edge and keeps each item's shape", () => {
    const aspects = [16 / 9, 4 / 3, 1, 9 / 16, 16 / 9, 3 / 2, 16 / 9, 1, 2];
    const rows = justifiedRows(aspects, opts);
    for (const row of rows.slice(0, -1)) {
      expect(rowWidth(row, opts.gap)).toBe(1000);
      const h = row[0]!.height;
      expect(row.every((b) => b.height === h)).toBe(true);
      // Every item is drawn at its own aspect (to within the rounding of one pixel; the last takes the remainder).
      for (const b of row.slice(0, -1)) expect(Math.abs(b.width / b.height - aspects[b.index]!)).toBeLessThan(0.02);
    }
    expect(rows.flat().map((b) => b.index)).toEqual(aspects.map((_, i) => i));
  });

  it("rows come out near the target height, never shorter than a full row needs", () => {
    const rows = justifiedRows(Array(20).fill(16 / 9), opts);
    for (const row of rows.slice(0, -1)) {
      expect(row[0]!.height).toBeGreaterThan(120);
      expect(row[0]!.height).toBeLessThanOrEqual(180);
    }
  });

  it("does not stretch the last row: one picture stays at the target height", () => {
    const rows = justifiedRows([16 / 9], opts);
    expect(rows).toHaveLength(1);
    expect(rows[0]![0]!.height).toBe(180);
    expect(rows[0]![0]!.width).toBe(Math.floor((16 / 9) * 180));
  });

  it("clamps panoramas and very tall pictures, and counts missing sizes as 16:9", () => {
    const rows = justifiedRows([20, 0.05], { ...opts, containerWidth: 2000 });
    const [pano, tall] = rows.flat();
    expect(pano!.width / pano!.height).toBeCloseTo(3, 1);
    expect(tall!.width / tall!.height).toBeCloseTo(0.5, 1);
    expect(aspectOf(null, 1080)).toBeCloseTo(16 / 9);
    expect(aspectOf(1080, 1920)).toBeCloseTo(9 / 16);
  });

  it("gives nothing for no items or no width (before the page is measured)", () => {
    expect(justifiedRows([], opts)).toEqual([]);
    expect(justifiedRows([1], { ...opts, containerWidth: 0 })).toEqual([]);
  });
});
