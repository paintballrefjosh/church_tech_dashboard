/**
 * Justified rows, as photo libraries (Google Photos, Immich) lay out pictures: every item keeps its own shape, each row is
 * scaled so it exactly fills the width, and rows end up about `targetHeight` tall. The last row is not stretched (a lone
 * picture would otherwise fill the page); it keeps the target height, or the height of the row above if that is smaller.
 */

export interface JustifiedBox {
  index: number;
  width: number;
  height: number;
}

export interface JustifiedOptions {
  containerWidth: number;
  targetHeight: number;
  gap: number;
  /** Very wide or very tall items are clamped to this aspect range so one panorama cannot take a whole row at 20 px. */
  minAspect?: number;
  maxAspect?: number;
  /** A row is never scaled taller than this many times the target (a narrow window with one tall item). */
  maxScale?: number;
}

/** Width over height; unknown or broken dimensions count as 16:9 (what the screens show). */
export function aspectOf(width: number | null | undefined, height: number | null | undefined): number {
  if (!width || !height || width <= 0 || height <= 0) return 16 / 9;
  return width / height;
}

export function justifiedRows(aspects: number[], o: JustifiedOptions): JustifiedBox[][] {
  const minA = o.minAspect ?? 0.5;
  const maxA = o.maxAspect ?? 3;
  const maxScale = o.maxScale ?? 1.6;
  const width = Math.max(0, o.containerWidth);
  if (!aspects.length || width <= 0) return [];
  const rows: JustifiedBox[][] = [];
  let row: Array<{ index: number; aspect: number }> = [];
  let sum = 0;
  let lastHeight = o.targetHeight;

  const build = (items: typeof row, height: number): JustifiedBox[] => {
    // Widths are rounded, and the rounding error goes to the last item so the row lines up exactly with the edge.
    const out = items.map((it) => ({ index: it.index, width: Math.floor(it.aspect * height), height: Math.round(height) }));
    return out;
  };

  aspects.forEach((raw, index) => {
    const aspect = Math.min(maxA, Math.max(minA, Number.isFinite(raw) && raw > 0 ? raw : 16 / 9));
    row.push({ index, aspect });
    sum += aspect;
    const gaps = o.gap * (row.length - 1);
    // Full once the row at the target height would be at least as wide as the space.
    if (sum * o.targetHeight + gaps >= width) {
      const height = Math.min((width - gaps) / sum, o.targetHeight * maxScale);
      const boxes = build(row, height);
      const used = boxes.reduce((t, b) => t + b.width, 0) + gaps;
      if (height < o.targetHeight * maxScale) boxes[boxes.length - 1]!.width += width - used;
      rows.push(boxes);
      lastHeight = height;
      row = [];
      sum = 0;
    }
  });
  if (row.length) rows.push(build(row, Math.min(o.targetHeight, lastHeight)));
  return rows;
}
