import { beforeAll, describe, expect, it } from "vitest";
import { drawEmf, emfRecords, emfTexts, readEmfHeader } from "./emf";
import { buildEmf, bytes, emfRecord, f32, u16, u32, utf16 } from "./test-builders";

/** Just enough of Path2D and a canvas context to see what the renderer asked for. */
class FakePath {
  ops: Array<[string, ...number[]]> = [];
  moveTo(x: number, y: number) { this.ops.push(["M", x, y]); }
  lineTo(x: number, y: number) { this.ops.push(["L", x, y]); }
  bezierCurveTo(a: number, b: number, c: number, d: number, e: number, f: number) { this.ops.push(["C", a, b, c, d, e, f]); }
  closePath() { this.ops.push(["Z"]); }
  rect(x: number, y: number, w: number, h: number) { this.ops.push(["R", x, y, w, h]); }
  ellipse(x: number, y: number, rx: number, ry: number) { this.ops.push(["E", x, y, rx, ry]); }
  addPath(p: FakePath) { this.ops.push(...p.ops); }
}
interface Painted { style: unknown; ops: FakePath["ops"]; rule?: string; width?: number }
function fakeCtx() {
  const fills: Painted[] = [];
  const strokes: Painted[] = [];
  const state: Record<string, unknown> = { fillStyle: "", strokeStyle: "", lineWidth: 1 };
  const ctx = new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k];
      switch (k) {
        case "fill": return (p: FakePath, rule?: string) => fills.push({ style: t.fillStyle, ops: p.ops, rule });
        case "stroke": return (p: FakePath) => strokes.push({ style: t.strokeStyle, ops: p.ops, width: t.lineWidth as number });
        case "measureText": return () => ({ width: 10 });
        default: return () => undefined;
      }
    },
    set(t, k: string, v) { t[k] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, fills, strokes };
}

beforeAll(() => {
  (globalThis as unknown as { Path2D: unknown }).Path2D = FakePath;
});

const redBrush = (ih = 1) => emfRecord(39, [...u32(ih), ...u32(0), ...u32(0x0000ff), ...u32(0)]);
const select = (ih: number) => emfRecord(37, u32(ih));
const polygon16 = (pts: Array<[number, number]>) =>
  emfRecord(86, [...new Array(16).fill(0), ...u32(pts.length), ...pts.flatMap(([x, y]) => [...u16(x), ...u16(y)])]);
const world = (a: number, b: number, c: number, d: number, e: number, f: number) => emfRecord(35, [...f32(a), ...f32(b), ...f32(c), ...f32(d), ...f32(e), ...f32(f)]);
const square: Array<[number, number]> = [[10, 10], [40, 10], [40, 30], [10, 30]];

describe("reading an EMF", () => {
  it("reads the bounds and size from the header, and refuses anything else", () => {
    const h = readEmfHeader(buildEmf([], [5, 7, 104, 56]))!;
    expect(h).toMatchObject({ left: 5, top: 7, width: 100, height: 50 });
    expect(readEmfHeader(new Uint8Array(200))).toBeNull();
    expect(readEmfHeader(new Uint8Array(10))).toBeNull();
  });

  it("walks the records and stops quietly at one that does not fit", () => {
    const good = buildEmf([select(1), select(2)]);
    expect([...emfRecords(good)].map((r) => r.type)).toEqual([1, 37, 37, 14]);
    // without its EOF record the others are still read; with the last record cut in half it is left out
    expect([...emfRecords(good.slice(0, good.length - 20))].map((r) => r.type)).toEqual([1, 37, 37]);
    expect([...emfRecords(good.slice(0, good.length - 26))].map((r) => r.type)).toEqual([1, 37]);
  });

  it("lists the text a picture draws, in order", () => {
    // EMR_EXTTEXTOUTW: bounds, mode and scales (36 bytes after the 8-byte header up to the reference point), the point,
    // the character count and the text's offset (76: just after the fixed part), options, a rectangle, and the text
    const text = (s: string) => emfRecord(84, [...new Array(36).fill(0), ...u32(s.length), ...u32(76), ...u32(0), ...new Array(16).fill(0), ...u32(0), ...utf16(s)]);
    expect(emfTexts(buildEmf([text("Catalyst "), text("3850 48")]))).toEqual(["Catalyst ", "3850 48"]);
    expect(emfTexts(buildEmf([]))).toEqual([]);
  });
});

describe("drawing an EMF", () => {
  it("fills a polygon with the selected brush, at the picture's own scale", () => {
    const { ctx, fills } = fakeCtx();
    const res = drawEmf(buildEmf([redBrush(), select(1), polygon16(square)]), ctx, { scale: 1 });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.style).toBe("rgb(255,0,0)");
    expect(fills[0]!.ops).toEqual([["M", 10, 10], ["L", 40, 10], ["L", 40, 30], ["L", 10, 30], ["Z"]]);
    expect(res.drawn).toBe(1);
  });

  it("scales to the canvas and starts at the picture's top left", () => {
    const { ctx, fills } = fakeCtx();
    drawEmf(buildEmf([redBrush(), select(1), polygon16(square)], [5, 5, 104, 54]), ctx, { scale: 2 });
    expect(fills[0]!.ops[0]).toEqual(["M", 10, 10]); // (10 - 5) * 2
    expect(fills[0]!.ops[1]).toEqual(["L", 70, 10]); // (40 - 5) * 2
  });

  it("applies the world transform, and left and right multiplication in GDI's order", () => {
    const a = fakeCtx();
    drawEmf(buildEmf([redBrush(), select(1), world(2, 0, 0, 2, 0, 0), polygon16(square)]), a.ctx, { scale: 1 });
    expect(a.fills[0]!.ops[0]).toEqual(["M", 20, 20]);

    // scale by 2, then (right multiply) translate by 5: a point is scaled, then moved
    const b = fakeCtx();
    const modify = (m: number[], mode: number) => emfRecord(36, [...m.flatMap(f32), ...u32(mode)]);
    drawEmf(buildEmf([redBrush(), select(1), modify([2, 0, 0, 2, 0, 0], 4), modify([1, 0, 0, 1, 5, 0], 3), polygon16(square)]), b.ctx, { scale: 1 });
    expect(b.fills[0]!.ops[0]).toEqual(["M", 25, 20]);
    // the same two steps left-multiplied: moved first, then scaled
    const c = fakeCtx();
    drawEmf(buildEmf([redBrush(), select(1), modify([2, 0, 0, 2, 0, 0], 4), modify([1, 0, 0, 1, 5, 0], 2), polygon16(square)]), c.ctx, { scale: 1 });
    expect(c.fills[0]!.ops[0]).toEqual(["M", 30, 20]);
  });

  it("builds a path between BEGINPATH and ENDPATH and paints it when told to", () => {
    const { ctx, fills, strokes } = fakeCtx();
    const move = (x: number, y: number) => emfRecord(27, [...u32(x), ...u32(y)]);
    const line = (x: number, y: number) => emfRecord(54, [...u32(x), ...u32(y)]);
    const fillPath = emfRecord(62, new Array(16).fill(0));
    const strokePath = emfRecord(64, new Array(16).fill(0));
    drawEmf(buildEmf([redBrush(), select(1), emfRecord(59), move(10, 10), line(20, 10), line(20, 20), emfRecord(61), emfRecord(60), fillPath, strokePath]), ctx, { scale: 1 });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.ops).toEqual([["M", 10, 10], ["L", 20, 10], ["L", 20, 20], ["Z"], ["M", 10, 10]]);
    expect(strokes).toHaveLength(1);
  });

  it("keeps a curve inside a path in one piece (the Bezier-to forms continue from the current point)", () => {
    const { ctx, fills } = fakeCtx();
    const move = emfRecord(27, [...u32(0), ...u32(0)]);
    const bez = emfRecord(88, [...new Array(16).fill(0), ...u32(3), ...[[10, 0], [20, 10], [20, 20]].flatMap(([x, y]) => [...u16(x!), ...u16(y!)])]);
    const lineTo = emfRecord(54, [...u32(0), ...u32(20)]);
    drawEmf(buildEmf([redBrush(), select(1), emfRecord(59), move, bez, lineTo, emfRecord(60), emfRecord(62, new Array(16).fill(0))]), ctx, { scale: 1 });
    const moves = fills[0]!.ops.filter((o) => o[0] === "M");
    expect(moves).toHaveLength(1);
    expect(fills[0]!.ops.some((o) => o[0] === "C")).toBe(true);
  });

  it("restores the brush with RESTOREDC", () => {
    const { ctx, fills } = fakeCtx();
    const blue = emfRecord(39, [...u32(2), ...u32(0), ...u32(0xff0000), ...u32(0)]);
    drawEmf(buildEmf([redBrush(1), blue, select(1), emfRecord(33), select(2), emfRecord(34, u32(0xffffffff)), polygon16(square)]), ctx, { scale: 1 });
    expect(fills[0]!.style).toBe("rgb(255,0,0)");
  });

  it("uses the stock null brush and pen (nothing is painted) and stock black for lines", () => {
    const { ctx, fills, strokes } = fakeCtx();
    drawEmf(buildEmf([select(0x80000005), select(0x80000008), polygon16(square)]), ctx, { scale: 1 });
    expect(fills).toHaveLength(0);
    expect(strokes).toHaveLength(0);
  });

  it("fills by the polygon fill mode: alternate (even-odd) by default, winding when set", () => {
    const a = fakeCtx();
    drawEmf(buildEmf([redBrush(), select(1), polygon16(square)]), a.ctx, { scale: 1 });
    expect(a.fills[0]!.rule).toBe("evenodd");
    const b = fakeCtx();
    drawEmf(buildEmf([redBrush(), select(1), emfRecord(19, u32(2)), polygon16(square)]), b.ctx, { scale: 1 });
    expect(b.fills[0]!.rule).toBe("nonzero");
  });

  it("skips records it does not know and counts them, but never stops for them", () => {
    const { ctx, fills } = fakeCtx();
    const res = drawEmf(buildEmf([emfRecord(118, [0, 0, 0, 0]), emfRecord(70, [0, 0, 0, 0]), redBrush(), select(1), polygon16(square)]), ctx, { scale: 1 });
    expect(res.skipped).toEqual({ 118: 1 }); // a comment (70) is expected and not counted
    expect(fills).toHaveLength(1);
  });

  it("refuses something that is not an EMF", () => {
    expect(() => drawEmf(bytes(new Array(200).fill(7)), fakeCtx().ctx, { scale: 1 })).toThrow(/not an EMF/);
  });
});
