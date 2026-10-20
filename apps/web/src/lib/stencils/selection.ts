/** Which picture is the front and which the back (at most one of each), for the importer. */
export type Side = "front" | "back";
export interface Assignment {
  front: string | null;
  back: string | null;
}

export const NONE: Assignment = { front: null, back: null };

/** Gives `side` to picture `id` (taking it from whichever picture had it, and moving `id` off its other side), or clears `id` with null. */
export function assign(a: Assignment, id: string, side: Side | null): Assignment {
  const next: Assignment = { front: a.front === id ? null : a.front, back: a.back === id ? null : a.back };
  if (side) next[side] = id;
  return next;
}

export function sideOf(a: Assignment, id: string): Side | null {
  return a.front === id ? "front" : a.back === id ? "back" : null;
}

/** The side to default a new model's ports to: the front if one was chosen, else the back. */
export function defaultPortSide(a: Assignment): Side {
  return a.front ? "front" : "back";
}

/** A file name for an upload ("cisco-nexus-3064pq-front.png"): the server stores it as the picture's name. */
export function uploadName(modelName: string, side: Side, mime: string): string {
  const base = modelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "switch";
  const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
  return `${base}-${side}.${ext}`;
}
