/**
 * Finding the ports on a photo of a switch, and numbering them: the "auto" in the switch model editor.
 *
 * Nothing here is exact and nothing is trusted: it proposes boxes and names, the admin drags them where they belong.
 * Sockets are found as dark, solid, roughly square blobs that are darker than their surroundings, then grouped by
 * size (RJ45 sockets, SFP cages and so on come out as separate groups). Pure functions on pixels, so they are tested
 * without a browser.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What `ImageData` is: RGBA bytes, row by row. */
export interface PixelImage {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

export interface DetectedGroup {
  /** Typical size of the boxes in the group, in the image's own pixels. */
  w: number;
  h: number;
  boxes: Box[];
}

/** The picture is shrunk to this many pixels across (inside the area asked for) before it is looked at. */
const WORK_WIDTH = 1400;
/** The smallest group that counts as a row of ports rather than a coincidence. */
const MIN_GROUP = 3;

function clampBox(b: Box, width: number, height: number): Box {
  const x = Math.max(0, Math.min(Math.floor(b.x), width - 1));
  const y = Math.max(0, Math.min(Math.floor(b.y), height - 1));
  const w = Math.max(1, Math.min(Math.ceil(b.w), width - x));
  const h = Math.max(1, Math.min(Math.ceil(b.h), height - y));
  return { x, y, w, h };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Proposes groups of port boxes (in the image's own pixels), the biggest group first. Empty when nothing looks like ports. */
export function detectPorts(img: PixelImage, area?: Box): DetectedGroup[] {
  const r = clampBox(area ?? { x: 0, y: 0, w: img.width, h: img.height }, img.width, img.height);
  const scale = Math.min(1, WORK_WIDTH / r.w);
  const W = Math.max(1, Math.round(r.w * scale));
  const H = Math.max(1, Math.round(r.h * scale));

  // Shrinking averages every source pixel under a work pixel (not one sample of it), so a thin light line between two
  // dark cells is still a slightly lighter column afterwards instead of being skipped over.
  const gray = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const sy0 = r.y + Math.floor(y / scale);
    const sy1 = Math.min(r.y + r.h, Math.max(sy0 + 1, r.y + Math.floor((y + 1) / scale)));
    for (let x = 0; x < W; x++) {
      const sx0 = r.x + Math.floor(x / scale);
      const sx1 = Math.min(r.x + r.w, Math.max(sx0 + 1, r.x + Math.floor((x + 1) / scale)));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < img.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < img.width; sx++) {
          const i = (sy * img.width + sx) * 4;
          sum += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
          n++;
        }
      }
      gray[y * W + x] = n > 0 ? sum / n : 255;
    }
  }

  // Summed-area table: the average brightness around a pixel for any window size in constant time.
  const sat = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += gray[y * W + x]!;
      sat[(y + 1) * (W + 1) + (x + 1)] = sat[y * (W + 1) + (x + 1)]! + row;
    }
  }

  let best: DetectedGroup[] = [];
  let bestScore = 0;
  // A socket has to be darker than what is around it. How big "around" is depends on how big the sockets are in this
  // picture, which is not known: try three windows, plus one fixed darkness cut-off for big dark cages on a light
  // faceplate (a window inside a big cage sees only the cage, so the cage is not darker than its own surroundings).
  // Each way is scored by how much of the picture its boxes cover, not by how many boxes it finds: printed marks and
  // arrows are many and tiny, sockets are fewer and big.
  const masks = [0.008, 0.016, 0.032].map((frac) => ({
    mask: localDarkMask(gray, sat, W, H, Math.max(4, Math.round(W * frac))),
    close: true,
  }));
  const cuts = darknessCutoff(gray);
  if (cuts !== null) {
    // Big cages sit side by side with thin light gaps, which shrinking blurs into the dark: besides the plain cut-off
    // there is a stricter one, nearer the dark tone itself, that keeps the gaps open. The mask is not closed for either
    // (closing would join the cages again); the plain one is also tried closed, for cages with light contacts inside.
    const strict = cuts.dark + 0.3 * (cuts.cut - cuts.dark);
    const plain = new Uint8Array(W * H);
    const tight = new Uint8Array(W * H);
    for (let i = 0; i < plain.length; i++) {
      if (gray[i]! <= cuts.cut) plain[i] = 1;
      if (gray[i]! <= strict) tight[i] = 1;
    }
    masks.push({ mask: tight, close: false }, { mask: plain, close: false }, { mask: plain, close: true });
  }
  for (const { mask, close } of masks) {
    const groups = groupsFromMask(mask, W, H, close);
    const score = groups.reduce((s, g, i) => s + g.boxes.length * g.w * g.h * (i === 0 ? 1 : 0.3), 0);
    if (score > bestScore) {
      bestScore = score;
      best = groups;
    }
  }
  return best.map((g) => ({
    w: g.w / scale,
    h: g.h / scale,
    boxes: g.boxes.map((b) => ({ x: r.x + b.x / scale, y: r.y + b.y / scale, w: b.w / scale, h: b.h / scale })),
  }));
}

/**
 * One fixed darkness cut-off for the whole area (Otsu's method), or null when the area is not clearly two-toned: a
 * light faceplate with dark sockets has a gap between the two, a flat or evenly noisy picture does not.
 */
function darknessCutoff(gray: Float32Array): { cut: number; dark: number } | null {
  const hist = new Float64Array(256);
  for (const v of gray) hist[Math.max(0, Math.min(255, Math.round(v)))]!++;
  const total = gray.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i]!;
  let wB = 0;
  let sumB = 0;
  let bestVar = 0;
  let cut = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      cut = t;
    }
  }
  // The dark side must be a minority with a real step between it and the light side.
  let darkCount = 0;
  let darkSum = 0;
  let lightSum = 0;
  for (const v of gray) {
    if (v <= cut) {
      darkCount++;
      darkSum += v;
    } else lightSum += v;
  }
  const lightCount = total - darkCount;
  if (darkCount === 0 || lightCount === 0) return null;
  if (darkCount > 0.6 * total) return null;
  if (lightSum / lightCount - darkSum / darkCount < 60) return null;
  return { cut, dark: darkSum / darkCount };
}

function localDarkMask(gray: Float32Array, sat: Float64Array, W: number, H: number, radius: number): Uint8Array {
  const stride = W + 1;
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(H, y + radius + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(W, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = (sat[y1 * stride + x1]! - sat[y0 * stride + x1]! - sat[y1 * stride + x0]! + sat[y0 * stride + x0]!) / area;
      if (gray[y * W + x]! < mean - Math.max(14, 0.15 * mean)) mask[y * W + x] = 1;
    }
  }
  return mask;
}

function groupsFromMask(mask: Uint8Array, W: number, H: number, close = true): DetectedGroup[] {
  // Close the one-pixel gaps a socket's contacts leave in it: grow the mask by a pixel, and shrink the boxes back after.
  const grown = close ? new Uint8Array(W * H) : mask;
  if (close) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy;
            const xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) grown[yy * W + xx] = 1;
          }
        }
      }
    }
  }
  const pad = close ? 1 : 0;

  const seen = new Uint8Array(W * H);
  const candidates: Box[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (!grown[start] || seen[start]) continue;
    let minX = W;
    let minY = H;
    let maxX = 0;
    let maxY = 0;
    let count = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const p = stack.pop()!;
      const px = p % W;
      const py = (p - px) / W;
      count++;
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      if (px > 0 && grown[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), stack.push(p - 1);
      if (px < W - 1 && grown[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), stack.push(p + 1);
      if (py > 0 && grown[p - W] && !seen[p - W]) (seen[p - W] = 1), stack.push(p - W);
      if (py < H - 1 && grown[p + W] && !seen[p + W]) (seen[p + W] = 1), stack.push(p + W);
    }
    const bw = maxX - minX + 1 - 2 * pad;
    const bh = maxY - minY + 1 - 2 * pad;
    if (bw < Math.max(5, 0.004 * W) || bh < 5 || bw > 0.2 * W || bh > 0.7 * H) continue;
    const aspect = bw / bh;
    if (aspect < 0.45 || aspect > 3.2) continue;
    if (count / ((bw + 2 * pad) * (bh + 2 * pad)) < 0.55) continue;
    candidates.push({ x: minX + pad, y: minY + pad, w: bw, h: bh });
  }

  // Group by size: every port of one kind is the same size.
  const groups: { w: number; h: number; boxes: Box[] }[] = [];
  for (const c of candidates) {
    const g = groups.find((q) => Math.abs(c.w - q.w) <= 0.22 * q.w && Math.abs(c.h - q.h) <= 0.22 * q.h);
    if (g) {
      g.boxes.push(c);
      g.w = g.boxes.reduce((s, b) => s + b.w, 0) / g.boxes.length;
      g.h = g.boxes.reduce((s, b) => s + b.h, 0) / g.boxes.length;
    } else {
      groups.push({ w: c.w, h: c.h, boxes: [c] });
    }
  }
  // Biggest first by the area a group covers: vent holes and marks are many and small, ports fewer and bigger.
  const covered = (g: { w: number; h: number; boxes: Box[] }) => g.boxes.length * g.w * g.h;
  return groups.filter((g) => g.boxes.length >= MIN_GROUP).sort((a, b) => covered(b) - covered(a));
}

// ---- numbering ----

/** "columns": down each column, then on to the next one (Cisco: 1 above 2). "rows": along each row, then the next row down. */
export type NumberingScheme = "columns" | "rows";

/** Orders boxes by how a switch numbers its ports; the returned array is in port order (first port first). */
export function orderBoxes(boxes: Box[], scheme: NumberingScheme): Box[] {
  if (boxes.length === 0) return [];
  const medW = median(boxes.map((b) => b.w));
  const medH = median(boxes.map((b) => b.h));
  // "Lines" are columns for the column scheme (boxes sharing a centre x) and rows for the row scheme.
  const centre = (b: Box) => (scheme === "columns" ? b.x + b.w / 2 : b.y + b.h / 2);
  const along = (b: Box) => (scheme === "columns" ? b.y + b.h / 2 : b.x + b.w / 2);
  const tolerance = 0.5 * (scheme === "columns" ? medW : medH);

  const sorted = [...boxes].sort((a, b) => centre(a) - centre(b));
  const lines: Box[][] = [];
  let lineMean = 0;
  for (const b of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(centre(b) - lineMean) <= tolerance) {
      last.push(b);
      lineMean = last.reduce((s, q) => s + centre(q), 0) / last.length;
    } else {
      lines.push([b]);
      lineMean = centre(b);
    }
  }
  return lines.flatMap((line) => line.sort((a, b) => along(a) - along(b)));
}

/** "Gi1/0/{n}" with 7 gives "Gi1/0/7"; a pattern with no {n} has the number added on the end. */
export function portName(pattern: string, n: number): string {
  return pattern.includes("{n}") ? pattern.split("{n}").join(String(n)) : `${pattern}${n}`;
}

/** Names every box in port order, starting at `start`. */
export function labelBoxes(boxes: Box[], opts: { scheme: NumberingScheme; pattern: string; start: number }): Array<{ name: string; box: Box }> {
  return orderBoxes(boxes, opts.scheme).map((box, i) => ({ name: portName(opts.pattern, opts.start + i), box }));
}

/**
 * An even grid of boxes across an area, for a picture the detector cannot read. `groupEvery` leaves a wider gap after
 * that many columns (a panel's blocks of six or twelve ports); 0 for none.
 */
export function gridBoxes(area: Box, rows: number, cols: number, groupEvery = 0): Box[] {
  if (rows < 1 || cols < 1) return [];
  const gaps = groupEvery > 0 ? Math.floor((cols - 1) / groupEvery) : 0;
  const GAP = 0.6; // a block gap, in column widths
  const unit = area.w / (cols + gaps * GAP);
  const rowH = area.h / rows;
  const w = unit * 0.82;
  const h = Math.min(rowH * 0.82, w * 1.2);
  const out: Box[] = [];
  for (let c = 0; c < cols; c++) {
    const gapsBefore = groupEvery > 0 ? Math.floor(c / groupEvery) : 0;
    const x = area.x + (c + gapsBefore * GAP) * unit + (unit - w) / 2;
    for (let r = 0; r < rows; r++) {
      out.push({ x, y: area.y + r * rowH + (rowH - h) / 2, w, h });
    }
  }
  return out;
}
