/**
 * Enhanced Metafile (EMF) reading and drawing, for the pictures inside Visio and PowerPoint stencils.
 *
 * Browsers cannot draw EMF, and the art in vendor stencils is EMF, so this draws the records those files use onto a
 * canvas: paths, polygons and Beziers, pens and brushes, transforms, clipping, bitmaps and text. Files written by
 * GDI+ ("EMF+ dual") carry their drawing twice, as EMF+ comments and as plain records; only the plain records are
 * drawn, so comments are skipped. Records this does not know are skipped and counted, never fatal: a picture that
 * is mostly right is more use than none. Parsing is pure (no DOM), so it is tested without a browser; drawing takes
 * a canvas context.
 */

export interface EmfHeader {
  /** Device-unit bounds of the picture, inclusive (the canvas covers right - left + 1 by bottom - top + 1). */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Size in device units. */
  width: number;
  height: number;
  records: number;
}

export interface EmfRecord {
  type: number;
  start: number;
  size: number;
}

const EMR = {
  HEADER: 1,
  POLYBEZIER: 2,
  POLYGON: 3,
  POLYLINE: 4,
  POLYBEZIERTO: 5,
  POLYLINETO: 6,
  POLYPOLYLINE: 7,
  POLYPOLYGON: 8,
  SETWINDOWEXTEX: 9,
  SETWINDOWORGEX: 10,
  SETVIEWPORTEXTEX: 11,
  SETVIEWPORTORGEX: 12,
  EOF: 14,
  SETMAPMODE: 17,
  SETBKMODE: 18,
  SETPOLYFILLMODE: 19,
  SETTEXTALIGN: 22,
  SETTEXTCOLOR: 24,
  SETBKCOLOR: 25,
  MOVETOEX: 27,
  SETMETARGN: 28,
  EXCLUDECLIPRECT: 29,
  INTERSECTCLIPRECT: 30,
  SAVEDC: 33,
  RESTOREDC: 34,
  SETWORLDTRANSFORM: 35,
  MODIFYWORLDTRANSFORM: 36,
  SELECTOBJECT: 37,
  CREATEPEN: 38,
  CREATEBRUSHINDIRECT: 39,
  DELETEOBJECT: 40,
  ELLIPSE: 42,
  RECTANGLE: 43,
  ROUNDRECT: 44,
  LINETO: 54,
  SETMITERLIMIT: 58,
  BEGINPATH: 59,
  ENDPATH: 60,
  CLOSEFIGURE: 61,
  FILLPATH: 62,
  STROKEANDFILLPATH: 63,
  STROKEPATH: 64,
  SELECTCLIPPATH: 67,
  ABORTPATH: 68,
  EXTSELECTCLIPRGN: 75,
  BITBLT: 76,
  STRETCHBLT: 77,
  SETDIBITSTODEVICE: 80,
  STRETCHDIBITS: 81,
  EXTCREATEFONTINDIRECTW: 82,
  EXTTEXTOUTW: 84,
  POLYBEZIER16: 85,
  POLYGON16: 86,
  POLYLINE16: 87,
  POLYBEZIERTO16: 88,
  POLYLINETO16: 89,
  POLYPOLYLINE16: 90,
  POLYPOLYGON16: 91,
  CREATEDIBPATTERNBRUSHPT: 94,
  EXTCREATEPEN: 95,
} as const;

const MAX_RECORDS = 3_000_000;
/** Records that need no drawing here: brush origin, ROP2, stretch mode, region, comments, ICM mode, layout. */
const IGNORED = new Set([13, 20, 21, 28, 70, 98, 115]);

/** Reads the header, or null when this is not an EMF. */
export function readEmfHeader(buf: Uint8Array): EmfHeader | null {
  if (buf.length < 88) return null;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 1 || dv.getUint32(40, true) !== 0x464d4520) return null;
  const left = dv.getInt32(8, true);
  const top = dv.getInt32(12, true);
  const right = dv.getInt32(16, true);
  const bottom = dv.getInt32(20, true);
  if (right < left || bottom < top) return null;
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, records: dv.getUint32(52, true) };
}

/** Every record in order; stops quietly at the first one that does not fit the file. */
export function* emfRecords(buf: Uint8Array): Generator<EmfRecord> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  let n = 0;
  while (pos + 8 <= buf.length && n++ < MAX_RECORDS) {
    const type = dv.getUint32(pos, true);
    const size = dv.getUint32(pos + 4, true);
    if (size < 8 || size % 4 !== 0 || pos + size > buf.length) return;
    yield { type, start: pos, size };
    if (type === EMR.EOF) return;
    pos += size;
  }
}

/** The text a picture draws, in drawing order (model names are often printed on the art): a hint for naming it. */
export function emfTexts(buf: Uint8Array): string[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: string[] = [];
  for (const r of emfRecords(buf)) {
    if (r.type !== EMR.EXTTEXTOUTW || r.size < 76) continue;
    const nChars = dv.getUint32(r.start + 44, true);
    const off = dv.getUint32(r.start + 48, true);
    if (nChars === 0 || nChars > 2048 || off + nChars * 2 > r.size) continue;
    let s = "";
    for (let i = 0; i < nChars; i++) s += String.fromCharCode(dv.getUint16(r.start + off + i * 2, true));
    out.push(s);
  }
  return out;
}

// ---- drawing state ----

/** An affine transform in GDI's order: a point is (x * m11 + y * m21 + dx, x * m12 + y * m22 + dy). */
interface Xform {
  m11: number;
  m12: number;
  m21: number;
  m22: number;
  dx: number;
  dy: number;
}
const IDENTITY: Xform = { m11: 1, m12: 0, m21: 0, m22: 1, dx: 0, dy: 0 };

/** Apply `a` first, then `b`. */
function then(a: Xform, b: Xform): Xform {
  return {
    m11: a.m11 * b.m11 + a.m12 * b.m21,
    m12: a.m11 * b.m12 + a.m12 * b.m22,
    m21: a.m21 * b.m11 + a.m22 * b.m21,
    m22: a.m21 * b.m12 + a.m22 * b.m22,
    dx: a.dx * b.m11 + a.dy * b.m21 + b.dx,
    dy: a.dx * b.m12 + a.dy * b.m22 + b.dy,
  };
}

interface Pen {
  kind: "pen";
  none: boolean;
  /** Width in logical units; 0 means a one-device-pixel line. */
  width: number;
  color: string;
  dash: number[];
  cap: CanvasLineCap;
  join: CanvasLineJoin;
}
interface Brush {
  kind: "brush";
  none: boolean;
  color: string;
  /** A bitmap that tiles, for pattern brushes (its own pixels, not scaled). */
  pattern?: CanvasLike;
}
interface Font {
  kind: "font";
  height: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  escapement: number;
  face: string;
}
type GdiObject = Pen | Brush | Font;

const BLACK = "rgb(0,0,0)";
const WHITE = "rgb(255,255,255)";
const NULL_PEN: Pen = { kind: "pen", none: true, width: 0, color: BLACK, dash: [], cap: "round", join: "round" };
const NULL_BRUSH: Brush = { kind: "brush", none: true, color: WHITE };

function stockObject(n: number): GdiObject | null {
  switch (n) {
    case 0: return { kind: "brush", none: false, color: WHITE };
    case 1: return { kind: "brush", none: false, color: "rgb(192,192,192)" };
    case 2: return { kind: "brush", none: false, color: "rgb(128,128,128)" };
    case 3: return { kind: "brush", none: false, color: "rgb(64,64,64)" };
    case 4: return { kind: "brush", none: false, color: BLACK };
    case 5: return NULL_BRUSH;
    case 6: return { kind: "pen", none: false, width: 0, color: WHITE, dash: [], cap: "round", join: "round" };
    case 7: return { kind: "pen", none: false, width: 0, color: BLACK, dash: [], cap: "round", join: "round" };
    case 8: return NULL_PEN;
    default: return { kind: "font", height: 16, weight: 400, italic: false, underline: false, strike: false, escapement: 0, face: "Arial" };
  }
}

interface ClipOp {
  path: Path2D;
  rule: CanvasFillRule;
  /** "and" intersects with what is already clipped; "diff" removes the path from it. */
  mode: "and" | "diff";
}

interface GdiState {
  world: Xform;
  mapMode: number;
  winOrg: [number, number];
  winExt: [number, number];
  vpOrg: [number, number];
  vpExt: [number, number];
  pen: Pen;
  brush: Brush;
  font: Font | null;
  textColor: string;
  bkColor: string;
  bkMode: number;
  textAlign: number;
  fillRule: CanvasFillRule;
  miter: number;
  pos: [number, number];
  clip: ClipOp[];
}

function freshState(): GdiState {
  return {
    world: IDENTITY,
    mapMode: 1,
    winOrg: [0, 0],
    winExt: [1, 1],
    vpOrg: [0, 0],
    vpExt: [1, 1],
    pen: stockObject(7) as Pen,
    brush: stockObject(0) as Brush,
    font: null,
    textColor: BLACK,
    bkColor: WHITE,
    bkMode: 2,
    textAlign: 0,
    fillRule: "evenodd",
    miter: 10,
    pos: [0, 0],
    clip: [],
  };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type CanvasLike = HTMLCanvasElement | OffscreenCanvas;

export interface EmfDrawOptions {
  /** Canvas pixels per device unit of the picture (the canvas is `width * scale` across). */
  scale: number;
  /** Makes a scratch canvas for bitmaps; defaults to an OffscreenCanvas, else a canvas element. */
  makeCanvas?: (w: number, h: number) => CanvasLike;
}

export interface EmfDrawResult {
  drawn: number;
  skipped: Record<number, number>;
}

function colorOf(ref: number): string {
  return `rgb(${ref & 255},${(ref >> 8) & 255},${(ref >> 16) & 255})`;
}

function defaultMakeCanvas(w: number, h: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Draws an EMF onto `ctx`, whose canvas should be `ceil(width * scale)` by `ceil(height * scale)`. The canvas is left
 * transparent where the picture draws nothing. Returns how many records were drawn and which kinds were skipped.
 */
export function drawEmf(buf: Uint8Array, ctx: Ctx, opts: EmfDrawOptions): EmfDrawResult {
  const header = readEmfHeader(buf);
  if (!header) throw new Error("This is not an EMF picture.");
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const makeCanvas = opts.makeCanvas ?? defaultMakeCanvas;
  const scale = opts.scale;

  const objects = new Map<number, GdiObject>();
  const saved: GdiState[] = [];
  let st = freshState();
  const skipped: Record<number, number> = {};
  let drawn = 0;

  // A path being recorded between BEGINPATH and ENDPATH (points already in canvas space).
  let building: Path2D | null = null;
  let finished: Path2D | null = null;
  let figureStart: [number, number] | null = null;

  let clipDirty = false;
  ctx.save();

  const i32 = (o: number) => dv.getInt32(o, true);
  const u32 = (o: number) => dv.getUint32(o, true);
  const f32 = (o: number) => dv.getFloat32(o, true);

  /** Logical point to canvas point: the world transform, then the window/viewport mapping, then the canvas scale. */
  function toCanvas(x: number, y: number): [number, number] {
    const wx = x * st.world.m11 + y * st.world.m21 + st.world.dx;
    const wy = x * st.world.m12 + y * st.world.m22 + st.world.dy;
    let px = wx;
    let py = wy;
    if (st.mapMode === 7 || st.mapMode === 8) {
      const ex = st.winExt[0] || 1;
      const ey = st.winExt[1] || 1;
      px = ((wx - st.winOrg[0]) * st.vpExt[0]) / ex + st.vpOrg[0];
      py = ((wy - st.winOrg[1]) * st.vpExt[1]) / ey + st.vpOrg[1];
    } else {
      px = wx - st.winOrg[0] + st.vpOrg[0];
      py = wy - st.winOrg[1] + st.vpOrg[1];
    }
    return [(px - header!.left) * scale, (py - header!.top) * scale];
  }
  /** The same mapping as a canvas matrix (for text and bitmaps). */
  function matrix(): [number, number, number, number, number, number] {
    const [e, f] = toCanvas(0, 0);
    const [ax, ay] = toCanvas(1, 0);
    const [cx, cy] = toCanvas(0, 1);
    return [ax - e, ay - f, cx - e, cy - f, e, f];
  }
  function lengthScale(): number {
    const [a, b, c, d] = matrix();
    return Math.sqrt(Math.abs(a * d - b * c)) || scale;
  }

  function applyClip() {
    if (!clipDirty) return;
    clipDirty = false;
    ctx.restore();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const op of st.clip) {
      if (op.mode === "and") {
        ctx.clip(op.path, op.rule);
      } else {
        const p = new Path2D();
        p.rect(-1e6, -1e6, 2e6, 2e6);
        p.addPath(op.path);
        ctx.clip(p, "evenodd");
      }
    }
  }

  function brushStyle(b: Brush): string | CanvasPattern {
    if (b.pattern) {
      const p = ctx.createPattern(b.pattern as CanvasImageSource, "repeat");
      if (p) return p;
    }
    return b.color;
  }

  function setPenStyle() {
    const p = st.pen;
    ctx.strokeStyle = p.color;
    ctx.lineWidth = p.width > 0 ? Math.max(p.width * lengthScale(), 0.5) : Math.max(scale, 0.75);
    ctx.lineCap = p.cap;
    ctx.lineJoin = p.join;
    ctx.miterLimit = st.miter;
    const k = p.width > 0 ? ctx.lineWidth : Math.max(scale, 1);
    ctx.setLineDash(p.dash.map((d) => d * k));
  }

  function paintShape(path: Path2D, fill: boolean, stroke: boolean) {
    if (building) return;
    applyClip();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (fill && !st.brush.none) {
      ctx.fillStyle = brushStyle(st.brush);
      ctx.fill(path, st.fillRule);
    }
    if (stroke && !st.pen.none) {
      setPenStyle();
      ctx.stroke(path);
    }
    drawn++;
  }

  /** Adds a polyline or polygon (points in logical units) to the path under construction, or draws it. */
  function polyShape(pts: Array<[number, number]>, close: boolean, fill: boolean, stroke: boolean, startNew = true) {
    if (pts.length === 0) return;
    const target = building ?? new Path2D();
    const first = toCanvas(pts[0]![0], pts[0]![1]);
    if (startNew) {
      target.moveTo(first[0], first[1]);
      figureStart = first;
    } else {
      target.lineTo(first[0], first[1]);
    }
    for (let i = 1; i < pts.length; i++) {
      const p = toCanvas(pts[i]![0], pts[i]![1]);
      target.lineTo(p[0], p[1]);
    }
    if (close) target.closePath();
    if (!building) paintShape(target, fill, stroke);
    const last = pts[pts.length - 1]!;
    st.pos = [last[0], last[1]];
  }

  function bezierShape(pts: Array<[number, number]>, from: [number, number] | null, fill: boolean, stroke: boolean) {
    const target = building ?? new Path2D();
    let i = 0;
    if (from) {
      // the "to" forms continue from the current point; inside a path that is already where the last segment ended
      if (!building) {
        const f = toCanvas(from[0], from[1]);
        target.moveTo(f[0], f[1]);
        figureStart = f;
      }
    } else if (pts.length > 0) {
      const f = toCanvas(pts[0]![0], pts[0]![1]);
      target.moveTo(f[0], f[1]);
      figureStart = f;
      i = 1;
    }
    for (; i + 2 < pts.length; i += 3) {
      const a = toCanvas(pts[i]![0], pts[i]![1]);
      const b = toCanvas(pts[i + 1]![0], pts[i + 1]![1]);
      const c = toCanvas(pts[i + 2]![0], pts[i + 2]![1]);
      target.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
    }
    if (!building) paintShape(target, fill, stroke);
    const last = pts[pts.length - 1];
    if (last) st.pos = [last[0], last[1]];
  }

  function readPoints(r: EmfRecord, at: number, count: number, wide: boolean): Array<[number, number]> {
    const size = wide ? 4 : 8;
    const out: Array<[number, number]> = [];
    if (count < 0 || at + count * size > r.start + r.size) return out;
    for (let i = 0; i < count; i++) {
      const o = r.start + at + i * size;
      out.push(wide ? [dv.getInt16(o, true), dv.getInt16(o + 2, true)] : [i32(o), i32(o + 4)]);
    }
    return out;
  }

  function rectPath(l: number, t: number, r: number, b: number): Path2D {
    const p = new Path2D();
    const pts = [toCanvas(l, t), toCanvas(r, t), toCanvas(r, b), toCanvas(l, b)];
    p.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < 4; i++) p.lineTo(pts[i]![0], pts[i]![1]);
    p.closePath();
    return p;
  }

  function select(handle: number) {
    if (handle & 0x80000000) {
      const o = stockObject(handle & 0x7fffffff);
      if (!o) return;
      apply(o);
      return;
    }
    const o = objects.get(handle);
    if (o) apply(o);
  }
  function apply(o: GdiObject) {
    if (o.kind === "pen") st.pen = o;
    else if (o.kind === "brush") st.brush = o;
    else st.font = o;
  }

  function dibToCanvas(r: EmfRecord, offBmi: number, cbBmi: number, offBits: number, cbBits: number): CanvasLike | null {
    if (cbBmi < 40 || offBmi + cbBmi > r.size || offBits + cbBits > r.size) return null;
    const b = r.start + offBmi;
    const headerSize = u32(b);
    if (headerSize < 40) return null;
    const w = i32(b + 4);
    let h = i32(b + 8);
    const bpp = dv.getUint16(b + 14, true);
    const compression = u32(b + 16);
    let clrUsed = u32(b + 32);
    const topDown = h < 0;
    h = Math.abs(h);
    if (w <= 0 || h <= 0 || w > 16384 || h > 16384) return null;
    if (compression !== 0 && compression !== 3) return null; // RLE and others: not drawn
    if (![1, 4, 8, 16, 24, 32].includes(bpp)) return null;
    if (bpp <= 8 && clrUsed === 0) clrUsed = 1 << bpp;
    const palette: number[][] = [];
    let palAt = b + headerSize;
    for (let i = 0; i < clrUsed && palAt + 4 <= r.start + r.size; i++, palAt += 4) palette.push([buf[palAt + 2]!, buf[palAt + 1]!, buf[palAt]!]);
    let masks: [number, number, number] | null = null;
    if (compression === 3 && (bpp === 16 || bpp === 32)) masks = [u32(b + headerSize), u32(b + headerSize + 4), u32(b + headerSize + 8)];
    const stride = ((w * bpp + 31) >> 5) << 2;
    const bits = r.start + offBits;
    if (cbBits < stride * h) return null;
    const canvas = makeCanvas(w, h);
    const c2 = (canvas as HTMLCanvasElement).getContext("2d") as Ctx | null;
    if (!c2) return null;
    const img = c2.createImageData(w, h);
    const px = img.data;
    // GDI draws a 32-bit bitmap opaque: its fourth byte is unused unless the record is an AlphaBlend (not drawn here).
    for (let y = 0; y < h; y++) {
      const srcRow = bits + (topDown ? y : h - 1 - y) * stride;
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let rr = 0, gg = 0, bb = 0, aa = 255;
        if (bpp === 24) {
          bb = buf[srcRow + x * 3]!; gg = buf[srcRow + x * 3 + 1]!; rr = buf[srcRow + x * 3 + 2]!;
        } else if (bpp === 32) {
          if (masks) {
            const v = dv.getUint32(srcRow + x * 4, true);
            rr = maskValue(v, masks[0]); gg = maskValue(v, masks[1]); bb = maskValue(v, masks[2]);
          } else {
            bb = buf[srcRow + x * 4]!; gg = buf[srcRow + x * 4 + 1]!; rr = buf[srcRow + x * 4 + 2]!;
          }
        } else if (bpp === 16) {
          const v = dv.getUint16(srcRow + x * 2, true);
          if (masks) { rr = maskValue(v, masks[0]); gg = maskValue(v, masks[1]); bb = maskValue(v, masks[2]); }
          else { rr = ((v >> 10) & 31) * 255 / 31; gg = ((v >> 5) & 31) * 255 / 31; bb = (v & 31) * 255 / 31; }
        } else {
          const bitIdx = x * bpp;
          const byte = buf[srcRow + (bitIdx >> 3)]!;
          const idx = bpp === 8 ? byte : (byte >> (8 - bpp - (bitIdx & 7))) & ((1 << bpp) - 1);
          const col = palette[idx] ?? [0, 0, 0];
          rr = col[0]!; gg = col[1]!; bb = col[2]!;
        }
        px[o] = rr; px[o + 1] = gg; px[o + 2] = bb; px[o + 3] = aa;
      }
    }
    c2.putImageData(img, 0, 0);
    return canvas;
  }

  function drawBitmap(canvas: CanvasLike, dx: number, dy: number, dw: number, dh: number, sx: number, sy: number, sw: number, sh: number) {
    if (building) return;
    applyClip();
    const m = matrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.save();
    // negative extents flip the picture
    ctx.translate(dw < 0 ? dx : dx, dh < 0 ? dy : dy);
    ctx.scale(dw < 0 ? -1 : 1, dh < 0 ? -1 : 1);
    ctx.drawImage(canvas as CanvasImageSource, sx, sy, sw, sh, 0, 0, Math.abs(dw), Math.abs(dh));
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawn++;
  }

  function drawText(r: EmfRecord) {
    if (building || r.size < 76) return;
    const refX = i32(r.start + 36);
    const refY = i32(r.start + 40);
    const nChars = u32(r.start + 44);
    const off = u32(r.start + 48);
    const offDx = u32(r.start + 72);
    if (nChars === 0 || nChars > 4096 || off + nChars * 2 > r.size) return;
    let s = "";
    for (let i = 0; i < nChars; i++) s += String.fromCharCode(dv.getUint16(r.start + off + i * 2, true));
    const f = st.font ?? (stockObject(13) as Font);
    const em = Math.max(1, f.height < 0 ? -f.height : f.height / 1.15);
    applyClip();
    const m = matrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.save();
    ctx.translate(refX, refY);
    if (f.escapement) ctx.rotate((-f.escapement / 10) * (Math.PI / 180));
    ctx.font = `${f.italic ? "italic " : ""}${f.weight >= 600 ? "bold " : ""}${em}px ${JSON.stringify(f.face)}, Arial, Helvetica, sans-serif`;
    ctx.fillStyle = st.textColor;
    ctx.textBaseline = (st.textAlign & 24) === 24 ? "alphabetic" : (st.textAlign & 8) === 8 ? "bottom" : "top";
    const align = st.textAlign & 6;
    // character positions: the record's advance widths when it has them, else the font's own
    const advances: number[] = [];
    if (offDx > 0 && offDx + nChars * 4 <= r.size) for (let i = 0; i < nChars; i++) advances.push(i32(r.start + offDx + i * 4));
    const total = advances.length ? advances.reduce((a, b) => a + b, 0) : ctx.measureText(s).width;
    const startX = align === 6 ? -total / 2 : align === 2 ? -total : 0;
    ctx.textAlign = "left";
    if (advances.length) {
      let x = startX;
      for (let i = 0; i < nChars; i++) {
        ctx.fillText(s[i]!, x, 0);
        x += advances[i]!;
      }
    } else {
      ctx.fillText(s, startX, 0);
    }
    if (f.underline || f.strike) {
      ctx.strokeStyle = st.textColor;
      ctx.lineWidth = Math.max(em / 14, 0.5);
      const y = f.strike ? -em * 0.3 : em * 0.12;
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(startX + total, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawn++;
  }

  function addClip(path: Path2D, mode: number, rule: CanvasFillRule = "nonzero") {
    // RGN_AND 1, RGN_OR 2, RGN_XOR 3, RGN_DIFF 4, RGN_COPY 5
    if (mode === 5) st.clip = [];
    st.clip = [...st.clip, { path, rule, mode: mode === 4 ? "diff" : "and" }];
    clipDirty = true;
  }

  for (const r of emfRecords(buf)) {
    const s = r.start;
    switch (r.type) {
      case EMR.HEADER:
      case EMR.EOF:
        break;
      case EMR.SETMAPMODE: st.mapMode = u32(s + 8); break;
      case EMR.SETWINDOWEXTEX: st.winExt = [i32(s + 8), i32(s + 12)]; break;
      case EMR.SETWINDOWORGEX: st.winOrg = [i32(s + 8), i32(s + 12)]; break;
      case EMR.SETVIEWPORTEXTEX: st.vpExt = [i32(s + 8), i32(s + 12)]; break;
      case EMR.SETVIEWPORTORGEX: st.vpOrg = [i32(s + 8), i32(s + 12)]; break;
      case EMR.SETBKMODE: st.bkMode = u32(s + 8); break;
      case EMR.SETPOLYFILLMODE: st.fillRule = u32(s + 8) === 2 ? "nonzero" : "evenodd"; break;
      case EMR.SETTEXTALIGN: st.textAlign = u32(s + 8); break;
      case EMR.SETTEXTCOLOR: st.textColor = colorOf(u32(s + 8)); break;
      case EMR.SETBKCOLOR: st.bkColor = colorOf(u32(s + 8)); break;
      case EMR.SETMITERLIMIT: st.miter = Math.max(1, u32(s + 8)); break;
      case EMR.MOVETOEX: {
        st.pos = [i32(s + 8), i32(s + 12)];
        if (building) {
          const p = toCanvas(st.pos[0], st.pos[1]);
          building.moveTo(p[0], p[1]);
          figureStart = p;
        }
        break;
      }
      case EMR.LINETO: {
        const to: [number, number] = [i32(s + 8), i32(s + 12)];
        if (building) {
          const p = toCanvas(to[0], to[1]);
          building.lineTo(p[0], p[1]);
        } else {
          const path = new Path2D();
          const a = toCanvas(st.pos[0], st.pos[1]);
          const b = toCanvas(to[0], to[1]);
          path.moveTo(a[0], a[1]);
          path.lineTo(b[0], b[1]);
          paintShape(path, false, true);
        }
        st.pos = to;
        break;
      }
      case EMR.POLYGON:
      case EMR.POLYGON16: {
        const wide = r.type === EMR.POLYGON16;
        polyShape(readPoints(r, 28, u32(s + 24), wide), true, true, true);
        break;
      }
      case EMR.POLYLINE:
      case EMR.POLYLINE16: {
        const wide = r.type === EMR.POLYLINE16;
        polyShape(readPoints(r, 28, u32(s + 24), wide), false, false, true);
        break;
      }
      case EMR.POLYLINETO:
      case EMR.POLYLINETO16: {
        const wide = r.type === EMR.POLYLINETO16;
        const pts = readPoints(r, 28, u32(s + 24), wide);
        if (building) {
          polyShape(pts, false, false, true, false);
        } else {
          polyShape([st.pos, ...pts], false, false, true);
        }
        break;
      }
      case EMR.POLYBEZIER:
      case EMR.POLYBEZIER16: {
        bezierShape(readPoints(r, 28, u32(s + 24), r.type === EMR.POLYBEZIER16), null, false, true);
        break;
      }
      case EMR.POLYBEZIERTO:
      case EMR.POLYBEZIERTO16: {
        bezierShape(readPoints(r, 28, u32(s + 24), r.type === EMR.POLYBEZIERTO16), st.pos, false, true);
        break;
      }
      case EMR.POLYPOLYGON:
      case EMR.POLYPOLYLINE:
      case EMR.POLYPOLYGON16:
      case EMR.POLYPOLYLINE16: {
        const wide = r.type === EMR.POLYPOLYGON16 || r.type === EMR.POLYPOLYLINE16;
        const polygon = r.type === EMR.POLYPOLYGON || r.type === EMR.POLYPOLYGON16;
        const nPolys = u32(s + 24);
        const total = u32(s + 28);
        if (nPolys > 100000 || total > 5_000_000) break;
        const counts: number[] = [];
        for (let i = 0; i < nPolys; i++) counts.push(u32(s + 32 + i * 4));
        const all = readPoints(r, 32 + nPolys * 4, total, wide);
        const target = building ?? new Path2D();
        const saveBuilding: Path2D | null = building;
        building = target;
        let at = 0;
        for (const c of counts) {
          polyShape(all.slice(at, at + c), polygon, false, false);
          at += c;
        }
        building = saveBuilding;
        if (!building) paintShape(target, polygon, true);
        break;
      }
      case EMR.RECTANGLE:
      case EMR.ELLIPSE:
      case EMR.ROUNDRECT: {
        const l = i32(s + 8), t = i32(s + 12), rt = i32(s + 16), b = i32(s + 20);
        const target = building ?? new Path2D();
        if (r.type === EMR.ELLIPSE) {
          const c = toCanvas((l + rt) / 2, (t + b) / 2);
          const m = matrix();
          const e = new Path2D();
          const sx = Math.hypot(m[0], m[1]);
          const sy = Math.hypot(m[2], m[3]);
          e.ellipse(c[0], c[1], (Math.abs(rt - l) / 2) * sx, (Math.abs(b - t) / 2) * sy, Math.atan2(m[1], m[0]), 0, Math.PI * 2);
          target.addPath(e);
        } else {
          target.addPath(rectPath(l, t, rt, b));
        }
        if (!building) paintShape(target, true, true);
        break;
      }
      case EMR.SAVEDC: saved.push({ ...st, clip: [...st.clip] }); break;
      case EMR.RESTOREDC: {
        const rel = i32(s + 8);
        let n = rel < 0 ? -rel : saved.length - rel + 1;
        let restored: GdiState | undefined;
        while (n-- > 0 && saved.length) restored = saved.pop();
        if (restored) {
          st = restored;
          clipDirty = true;
        }
        break;
      }
      case EMR.SETWORLDTRANSFORM:
        st.world = { m11: f32(s + 8), m12: f32(s + 12), m21: f32(s + 16), m22: f32(s + 20), dx: f32(s + 24), dy: f32(s + 28) };
        break;
      case EMR.MODIFYWORLDTRANSFORM: {
        const x: Xform = { m11: f32(s + 8), m12: f32(s + 12), m21: f32(s + 16), m22: f32(s + 20), dx: f32(s + 24), dy: f32(s + 28) };
        const mode = u32(s + 32);
        if (mode === 1) st.world = IDENTITY;
        else if (mode === 2) st.world = then(x, st.world);
        else if (mode === 3) st.world = then(st.world, x);
        else if (mode === 4) st.world = x;
        break;
      }
      case EMR.SELECTOBJECT: select(u32(s + 8)); break;
      case EMR.DELETEOBJECT: objects.delete(u32(s + 8)); break;
      case EMR.CREATEPEN: {
        const style = u32(s + 12) & 0xff;
        objects.set(u32(s + 8), makePen(style, i32(s + 16), colorOf(u32(s + 24)), 0, []));
        break;
      }
      case EMR.EXTCREATEPEN: {
        const style = u32(s + 28);
        const n = u32(s + 48);
        const dash: number[] = [];
        if (n > 0 && n < 64) for (let i = 0; i < n; i++) dash.push(u32(s + 52 + i * 4));
        objects.set(u32(s + 8), makePen(style & 0xff, u32(s + 32), colorOf(u32(s + 40)), style & 0xffff00, dash));
        break;
      }
      case EMR.CREATEDIBPATTERNBRUSHPT: {
        const tile = dibToCanvas(r, u32(s + 16), u32(s + 20), u32(s + 24), u32(s + 28));
        objects.set(u32(s + 8), tile ? { kind: "brush", none: false, color: "rgb(128,128,128)", pattern: tile } : { kind: "brush", none: false, color: "rgb(128,128,128)" });
        break;
      }
      case EMR.CREATEBRUSHINDIRECT: {
        const style = u32(s + 12);
        // 0 solid, 1 null, 2 hatch (drawn solid), anything else a pattern: a mid grey stands in
        objects.set(u32(s + 8), style === 1 ? NULL_BRUSH : { kind: "brush", none: false, color: style === 0 || style === 2 ? colorOf(u32(s + 16)) : "rgb(128,128,128)" });
        break;
      }
      case EMR.EXTCREATEFONTINDIRECTW: {
        const b = s + 12;
        let face = "";
        for (let i = 0; i < 32; i++) {
          const ch = dv.getUint16(b + 28 + i * 2, true);
          if (ch === 0) break;
          face += String.fromCharCode(ch);
        }
        objects.set(u32(s + 8), {
          kind: "font",
          height: i32(b),
          escapement: i32(b + 8),
          weight: i32(b + 16),
          italic: buf[b + 20] !== 0,
          underline: buf[b + 21] !== 0,
          strike: buf[b + 22] !== 0,
          face: face || "Arial",
        });
        break;
      }
      case EMR.BEGINPATH:
        building = new Path2D();
        finished = null;
        figureStart = null;
        break;
      case EMR.ENDPATH:
        finished = building;
        building = null;
        break;
      case EMR.CLOSEFIGURE:
        if (building) {
          building.closePath();
          if (figureStart) building.moveTo(figureStart[0], figureStart[1]);
        }
        break;
      case EMR.ABORTPATH:
        building = null;
        finished = null;
        break;
      case EMR.FILLPATH:
        if (finished) paintShape(finished, true, false);
        break;
      case EMR.STROKEPATH:
        if (finished) paintShape(finished, false, true);
        break;
      case EMR.STROKEANDFILLPATH:
        if (finished) paintShape(finished, true, true);
        break;
      case EMR.SELECTCLIPPATH:
        if (finished) addClip(finished, u32(s + 8), st.fillRule);
        break;
      case EMR.INTERSECTCLIPRECT:
        addClip(rectPath(i32(s + 8), i32(s + 12), i32(s + 16), i32(s + 20)), 1);
        break;
      case EMR.EXCLUDECLIPRECT:
        addClip(rectPath(i32(s + 8), i32(s + 12), i32(s + 16), i32(s + 20)), 4);
        break;
      case EMR.SETMETARGN:
        break;
      case EMR.EXTSELECTCLIPRGN: {
        const cb = u32(s + 8);
        const mode = u32(s + 12);
        if (cb === 0) {
          if (mode === 5) {
            st.clip = [];
            clipDirty = true;
          }
          break;
        }
        const count = u32(s + 16 + 8);
        const p = new Path2D();
        for (let i = 0; i < count && 16 + 32 + i * 16 + 16 <= r.size; i++) {
          const o = s + 16 + 32 + i * 16;
          p.addPath(rectPath(i32(o), i32(o + 4), i32(o + 8), i32(o + 12)));
        }
        addClip(p, mode, "nonzero");
        break;
      }
      case EMR.STRETCHDIBITS: {
        const canvas = dibToCanvas(r, u32(s + 48), u32(s + 52), u32(s + 56), u32(s + 60));
        if (canvas) drawBitmap(canvas, i32(s + 24), i32(s + 28), i32(s + 72), i32(s + 76), i32(s + 32), i32(s + 36), i32(s + 40), i32(s + 44));
        else skip(r.type);
        break;
      }
      case EMR.SETDIBITSTODEVICE: {
        const canvas = dibToCanvas(r, u32(s + 48), u32(s + 52), u32(s + 56), u32(s + 60));
        if (canvas) drawBitmap(canvas, i32(s + 24), i32(s + 28), i32(s + 40), i32(s + 44), i32(s + 32), i32(s + 36), i32(s + 40), i32(s + 44));
        else skip(r.type);
        break;
      }
      case EMR.BITBLT:
      case EMR.STRETCHBLT: {
        const rop = u32(s + 40);
        const cbBmi = u32(s + 88);
        const dx = i32(s + 24), dy = i32(s + 28), dw = i32(s + 32), dh = i32(s + 36);
        if (cbBmi === 0) {
          // no source bitmap: the raster operation fills the rectangle (pattern copy, black or white)
          if (rop === 0xf00021 || rop === 0x42 || rop === 0xff0062) {
            if (!building) {
              applyClip();
              ctx.setTransform(1, 0, 0, 1, 0, 0);
              ctx.fillStyle = rop === 0x42 ? BLACK : rop === 0xff0062 ? WHITE : brushStyle(st.brush);
              if (rop !== 0xf00021 || !st.brush.none) ctx.fill(rectPath(dx, dy, dx + dw, dy + dh));
              drawn++;
            }
          } else if (rop !== 0xaa0029) skip(r.type); // 0xAA0029 leaves the destination as it is
          break;
        }
        const canvas = dibToCanvas(r, u32(s + 84), cbBmi, u32(s + 92), u32(s + 96));
        if (canvas) {
          const sw = r.type === EMR.STRETCHBLT ? i32(s + 100) : dw;
          const sh = r.type === EMR.STRETCHBLT ? i32(s + 104) : dh;
          drawBitmap(canvas, dx, dy, dw, dh, i32(s + 44), i32(s + 48), sw, sh);
        } else skip(r.type);
        break;
      }
      case EMR.EXTTEXTOUTW:
        drawText(r);
        break;
      default:
        // comments (EMF+ and others) and settings that do not change a picture drawn in this way are expected; the rest is counted
        if (!IGNORED.has(r.type)) skip(r.type);
        break;
    }
  }

  function skip(type: number) {
    skipped[type] = (skipped[type] ?? 0) + 1;
  }

  ctx.restore();
  return { drawn, skipped };
}

function maskValue(v: number, mask: number): number {
  if (mask === 0) return 0;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift++;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1 && shift + bits < 32) bits++;
  const raw = (v & mask) >>> shift;
  return bits >= 8 ? raw >> (bits - 8) : (raw * 255) / ((1 << bits) - 1);
}

function makePen(style: number, width: number, color: string, flags: number, userDash: number[]): Pen {
  if (style === 5) return NULL_PEN;
  const dashes: Record<number, number[]> = { 1: [3, 1], 2: [1, 1], 3: [3, 1, 1, 1], 4: [3, 1, 1, 1, 1, 1] };
  const cap: CanvasLineCap = (flags & 0xf00) === 0x100 ? "square" : (flags & 0xf00) === 0x200 ? "butt" : "round";
  const join: CanvasLineJoin = (flags & 0xf000) === 0x1000 ? "bevel" : (flags & 0xf000) === 0x2000 ? "miter" : "round";
  return { kind: "pen", none: false, width: Math.max(0, width), color, dash: style === 7 ? userDash : (dashes[style] ?? []), cap, join };
}
