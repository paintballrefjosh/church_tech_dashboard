import type { RackItemRow } from "./schemas/rack";

/**
 * The arithmetic of a cabinet, kept pure so the elevation page, the print page and the API all agree.
 *
 * U numbers count from the BOTTOM of the cabinet (U1 is the lowest slot, as stamped on a real rail). An item with
 * `startU: 10, heightU: 2` occupies U10 and U11; its top is U11.
 */

type Place = Pick<RackItemRow, "startU" | "heightU">;
type PlacedItem = Place & { id: string };

/** The highest U an item occupies. */
export function topU(p: Place): number {
  return p.startU + p.heightU - 1;
}

/** True when the place lies wholly inside a cabinet of `units`. */
export function fitsCabinet(units: number, p: Place): boolean {
  return Number.isInteger(p.startU) && Number.isInteger(p.heightU) && p.startU >= 1 && p.heightU >= 1 && topU(p) <= units;
}

/** The first item that overlaps `p` (ignoring `exceptId`, so an item being moved does not collide with itself). */
export function findConflict<T extends PlacedItem>(items: readonly T[], p: Place, exceptId?: string): T | null {
  for (const it of items) {
    if (it.id === exceptId) continue;
    if (p.startU <= topU(it) && it.startU <= topU(p)) return it;
  }
  return null;
}

/** Why a place is not allowed, in words for a person, or null when it is fine. */
export function placementProblem<T extends PlacedItem & { label?: string }>(
  units: number,
  items: readonly T[],
  p: Place,
  exceptId?: string,
): string | null {
  if (!fitsCabinet(units, p)) {
    return p.startU < 1 || p.heightU < 1
      ? "U numbers and heights start at 1."
      : `That does not fit: it would reach U${topU(p)} and this cabinet is ${units}U.`;
  }
  const hit = findConflict(items, p, exceptId);
  if (hit) {
    const name = hit.label ? ` (${hit.label})` : "";
    return `U${Math.max(p.startU, hit.startU)} is already taken by an item${name} that fills U${hit.startU}${hit.heightU > 1 ? `-U${topU(hit)}` : ""}.`;
  }
  return null;
}

/** The lowest start U where `heightU` free units fit, or null when the cabinet has no room that big. */
export function firstFreeSlot(units: number, items: readonly PlacedItem[], heightU: number): number | null {
  for (let start = 1; start + heightU - 1 <= units; start++) {
    const hit = findConflict(items, { startU: start, heightU });
    if (!hit) return start;
    // Jump past the item in the way instead of testing every U inside it.
    start = topU(hit);
  }
  return null;
}

export type RackRow<T extends PlacedItem> =
  | { kind: "item"; item: T; topU: number; heightU: number }
  | { kind: "empty"; topU: number; heightU: 1 };

/**
 * The cabinet from the top down: each item once, every free U as its own row. Items that run past the top of the
 * cabinet (a cabinet shrunk after items were placed) are still listed, at the top, so nothing disappears.
 */
export function rackRows<T extends PlacedItem>(units: number, items: readonly T[]): Array<RackRow<T>> {
  const sorted = [...items].sort((a, b) => topU(b) - topU(a));
  const rows: Array<RackRow<T>> = [];
  let u = Math.max(units, ...sorted.map(topU), 0);
  let i = 0;
  while (u >= 1) {
    const it = sorted[i];
    if (it && topU(it) >= u) {
      rows.push({ kind: "item", item: it, topU: topU(it), heightU: it.heightU });
      u = it.startU - 1;
      i += 1;
      continue;
    }
    rows.push({ kind: "empty", topU: u, heightU: 1 });
    u -= 1;
  }
  return rows;
}

/** How many U are occupied. */
export function usedUnits(items: ReadonlyArray<Pick<Place, "heightU">>): number {
  return items.reduce((n, it) => n + it.heightU, 0);
}

/** A 19" rack unit is 44.45 mm high and the panel 482.6 mm wide. */
const PANEL_WIDTH_MM = 482.6;
const U_MM = 44.45;

/**
 * How many U a picture of a rack-mount device is, from its proportions (a picture cropped to the chassis, edge to edge).
 * A suggestion for the form, never a rule: 1 when the picture is missing or odd.
 */
export function suggestHeightU(width: number | null | undefined, height: number | null | undefined, maxUnits = 60): number {
  if (!width || !height || width <= 0 || height <= 0) return 1;
  const u = Math.round((PANEL_WIDTH_MM * (height / width)) / U_MM);
  return Math.min(Math.max(u, 1), maxUnits);
}

/** Whether a picture's proportions are close enough to its slot to stretch it to fill (else it is fitted inside). */
export function pictureFitsSlot(width: number | null | undefined, height: number | null | undefined, heightU: number): boolean {
  if (!width || !height || width <= 0 || height <= 0 || heightU < 1) return false;
  const want = PANEL_WIDTH_MM / (U_MM * heightU);
  const have = width / height;
  return Math.abs(have - want) / want <= 0.2;
}
