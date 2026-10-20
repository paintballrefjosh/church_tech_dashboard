import { describe, expect, it } from "vitest";
import { detectPorts, gridBoxes, labelBoxes, orderBoxes, portName, type Box, type PixelImage } from "./detect";

/** A light grey panel with rectangles of another grey on it, plus a little deterministic noise. */
function panel(width: number, height: number, rects: Array<Box & { value?: number }>, noise = 6): PixelImage {
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2 * noise;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let v = 190;
      for (const r of rects) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) v = r.value ?? 35;
      v += rand();
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Two rows of `cols` sockets, `w` x `h`, `pitch` apart. */
function sockets(x0: number, y0: number, cols: number, w = 30, h = 26, pitch = 40, rowGap = 12): Box[] {
  const out: Box[] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < 2; r++) out.push({ x: x0 + c * pitch, y: y0 + r * (h + rowGap), w, h });
  return out;
}

const near = (a: Box, b: Box, tol = 3) => Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol && Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;

describe("detectPorts", () => {
  it("finds a two-row panel of sockets where they are", () => {
    const truth = sockets(60, 40, 12);
    const found = detectPorts(panel(600, 130, truth));
    expect(found.length).toBeGreaterThan(0);
    const boxes = found[0]!.boxes;
    expect(boxes.length).toBe(24);
    for (const t of truth) expect(boxes.some((b) => near(b, t)), `socket at ${t.x},${t.y}`).toBe(true);
  });

  it("keeps different sizes apart (RJ45 sockets and bigger cages) and ignores thin labels and specks", () => {
    const rj = sockets(40, 30, 8);
    const cages: Box[] = [
      { x: 400, y: 30, w: 52, h: 36 },
      { x: 470, y: 30, w: 52, h: 36 },
      { x: 400, y: 80, w: 52, h: 36 },
      { x: 470, y: 80, w: 52, h: 36 },
    ];
    const clutter: Box[] = [
      { x: 40, y: 5, w: 300, h: 4 }, // a printed line
      { x: 10, y: 60, w: 4, h: 4 }, // an LED
      { x: 20, y: 90, w: 4, h: 4 },
    ];
    const groups = detectPorts(panel(560, 140, [...rj, ...cages, ...clutter]));
    expect(groups.length).toBe(2);
    expect(groups[0]!.boxes.length).toBe(16);
    expect(groups[1]!.boxes.length).toBe(4);
    expect(groups[1]!.w).toBeGreaterThan(groups[0]!.w * 1.4);
  });

  it("finds big dark cages side by side with thin gaps, and ranks them above many small vent holes and marks", () => {
    // Modelled on a drawn Nexus 3000 front (3200 px wide): 24 columns of two cages, 91 x 57 with a 3 px gap, a row of
    // small round vents under them (more of them than there are cages) and tiny arrow marks over the cages.
    const cages = sockets(295, 82, 24, 91, 57, 94, 37);
    const vents: Box[] = [];
    for (let i = 0; i < 100; i++) vents.push({ x: 300 + i * 28, y: 256, w: 18, h: 18 });
    const marks: Array<Box & { value: number }> = [];
    for (let i = 0; i < 24; i++) marks.push({ x: 310 + i * 94, y: 50, w: 14, h: 11, value: 60 });
    const found = detectPorts(panel(2700, 311, [...cages, ...vents, ...marks]));
    expect(found[0]!.boxes.length).toBe(48);
    for (const t of cages) expect(found[0]!.boxes.some((b) => near(b, t, 6)), `cage at ${t.x},${t.y}`).toBe(true);
    // the vents may come out as a group of their own, but a much smaller one than the cages
    for (const g of found.slice(1)) expect(g.w).toBeLessThan(found[0]!.w * 0.5);
  });

  it("finds nothing on a plain panel", () => {
    expect(detectPorts(panel(400, 100, []))).toEqual([]);
  });

  it("looks only inside the area it is given, in the image's own pixels", () => {
    const left = sockets(20, 30, 6);
    const right = sockets(340, 30, 6);
    const img = panel(640, 120, [...left, ...right]);
    const found = detectPorts(img, { x: 300, y: 0, w: 340, h: 120 });
    expect(found[0]!.boxes.length).toBe(12);
    for (const b of found[0]!.boxes) expect(b.x).toBeGreaterThanOrEqual(300);
  });

  it("copes with a big picture by working on a smaller copy and scaling the boxes back", () => {
    const truth = sockets(120, 80, 10, 60, 52, 80, 24);
    const found = detectPorts(panel(2000, 260, truth));
    const boxes = found[0]!.boxes;
    expect(boxes.length).toBe(20);
    for (const t of truth) expect(boxes.some((b) => near(b, t, 6)), `socket at ${t.x},${t.y}`).toBe(true);
  });
});

describe("numbering", () => {
  const grid = sockets(0, 0, 4); // 4 columns x 2 rows

  it("columns: down each column, then on (Cisco: 1 above 2)", () => {
    const ordered = orderBoxes([...grid].reverse(), "columns");
    expect(ordered.map((b) => [b.x / 40, b.y > 0 ? 1 : 0])).toEqual([
      [0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1],
    ]);
  });

  it("rows: along the top row, then the one below", () => {
    const ordered = orderBoxes(grid, "rows");
    expect(ordered.map((b) => [b.x / 40, b.y > 0 ? 1 : 0])).toEqual([
      [0, 0], [1, 0], [2, 0], [3, 0], [0, 1], [1, 1], [2, 1], [3, 1],
    ]);
  });

  it("copes with boxes that are a little out of line", () => {
    const wobbly = grid.map((b, i) => ({ ...b, x: b.x + (i % 3) - 1, y: b.y + ((i * 7) % 5) - 2 }));
    expect(orderBoxes(wobbly, "columns").map((b) => Math.round(b.x / 40) + 0)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("names in port order from a pattern", () => {
    expect(portName("Gi1/0/{n}", 7)).toBe("Gi1/0/7");
    expect(portName("Eth1/", 7)).toBe("Eth1/7");
    const named = labelBoxes(grid, { scheme: "columns", pattern: "Gi1/0/{n}", start: 1 });
    expect(named.map((n) => n.name)).toEqual(["Gi1/0/1", "Gi1/0/2", "Gi1/0/3", "Gi1/0/4", "Gi1/0/5", "Gi1/0/6", "Gi1/0/7", "Gi1/0/8"]);
    expect(named[1]!.box.y).toBeGreaterThan(named[0]!.box.y);
    expect(labelBoxes(grid, { scheme: "rows", pattern: "{n}", start: 49 })[0]!.name).toBe("49");
  });
});

describe("gridBoxes", () => {
  it("lays rows x cols boxes inside the area, with a wider gap between blocks", () => {
    const area = { x: 100, y: 20, w: 600, h: 80 };
    const g = gridBoxes(area, 2, 24, 6);
    expect(g.length).toBe(48);
    for (const b of g) {
      expect(b.x).toBeGreaterThanOrEqual(area.x);
      expect(b.x + b.w).toBeLessThanOrEqual(area.x + area.w + 0.001);
      expect(b.y).toBeGreaterThanOrEqual(area.y);
      expect(b.y + b.h).toBeLessThanOrEqual(area.y + area.h + 0.001);
    }
    const colX = [...new Set(g.map((b) => b.x))].sort((a, b) => a - b);
    const step = colX[1]! - colX[0]!;
    expect(colX[6]! - colX[5]!).toBeGreaterThan(step * 1.3);
    expect(colX[7]! - colX[6]!).toBeCloseTo(step, 5);
  });

  it("makes nothing from an empty grid", () => {
    expect(gridBoxes({ x: 0, y: 0, w: 10, h: 10 }, 0, 5)).toEqual([]);
  });
});
