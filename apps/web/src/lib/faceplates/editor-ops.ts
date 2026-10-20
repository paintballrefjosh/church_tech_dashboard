import type { SwitchModelPort, SwitchPortKind } from "@church/shared";

/**
 * What the port layout editor does to boxes, as pure functions so it can be tested without a pointer. Positions and
 * sizes are fractions of the picture (0 to 1), like a stored port.
 */

export interface EditorPort extends SwitchModelPort {
  /** Only for this editing session: names can change, so they cannot identify a box. */
  uid: string;
}

export interface Frac {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const MIN_PORT_SIZE = 0.003;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function toEditorPorts(ports: readonly SwitchModelPort[]): EditorPort[] {
  return ports.map((p, i) => ({ ...p, uid: `p${i}-${Math.random().toString(36).slice(2, 8)}` }));
}

export function fromEditorPorts(ports: readonly EditorPort[]): SwitchModelPort[] {
  return ports.map(({ uid: _uid, ...p }) => ({
    ...p,
    x: round(p.x),
    y: round(p.y),
    w: round(p.w),
    h: round(p.h),
  }));
}

function round(n: number): number {
  return Math.round(n * 100000) / 100000;
}

let counter = 0;
export function newUid(): string {
  counter += 1;
  return `n${Date.now().toString(36)}-${counter}`;
}

/** The boxes moved by (dx, dy) as one group: the group stops at the picture's edge, it does not squash. */
export function moveBoxes(ports: readonly EditorPort[], uids: ReadonlySet<string>, dx: number, dy: number): EditorPort[] {
  const picked = ports.filter((p) => uids.has(p.uid));
  if (picked.length === 0) return [...ports];
  const minX = Math.min(...picked.map((p) => p.x));
  const maxX = Math.max(...picked.map((p) => p.x + p.w));
  const minY = Math.min(...picked.map((p) => p.y));
  const maxY = Math.max(...picked.map((p) => p.y + p.h));
  const gx = clamp(dx, -minX, 1 - maxX);
  const gy = clamp(dy, -minY, 1 - maxY);
  return ports.map((p) => (uids.has(p.uid) ? { ...p, x: p.x + gx, y: p.y + gy } : p));
}

/** Every selected box grown or shrunk by (dw, dh) from its top left corner, so they stay one size and inside the picture. */
export function resizeBoxes(ports: readonly EditorPort[], uids: ReadonlySet<string>, dw: number, dh: number): EditorPort[] {
  const picked = ports.filter((p) => uids.has(p.uid));
  if (picked.length === 0) return [...ports];
  // One shared change, limited by the box that has the least room either way.
  const lowW = Math.max(...picked.map((p) => MIN_PORT_SIZE - p.w));
  const highW = Math.min(...picked.map((p) => 1 - p.x - p.w));
  const lowH = Math.max(...picked.map((p) => MIN_PORT_SIZE - p.h));
  const highH = Math.min(...picked.map((p) => 1 - p.y - p.h));
  const gw = clamp(dw, lowW, Math.max(lowW, highW));
  const gh = clamp(dh, lowH, Math.max(lowH, highH));
  return ports.map((p) => (uids.has(p.uid) ? { ...p, w: p.w + gw, h: p.h + gh } : p));
}

/** Gives the selected boxes the size of the first one. */
export function matchSize(ports: readonly EditorPort[], uids: ReadonlySet<string>, reference: string): EditorPort[] {
  const ref = ports.find((p) => p.uid === reference);
  if (!ref) return [...ports];
  return ports.map((p) =>
    uids.has(p.uid) ? { ...p, w: Math.min(ref.w, 1 - p.x), h: Math.min(ref.h, 1 - p.y) } : p,
  );
}

export function intersects(a: Frac, b: Frac): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** The rectangle between two corner points, whichever way it was dragged. */
export function rectFrom(x0: number, y0: number, x1: number, y1: number): Frac {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/** A name (or alias) used by more than one port, lower-cased: such a layout cannot be saved. */
export function duplicateNames(ports: readonly EditorPort[]): Set<string> {
  const seen = new Map<string, string>();
  const dup = new Set<string>();
  for (const p of ports) {
    for (const n of [p.name, ...p.aliases]) {
      const k = n.trim().toLowerCase();
      if (!k) continue;
      const owner = seen.get(k);
      if (owner !== undefined && owner !== p.uid) dup.add(k);
      seen.set(k, p.uid);
    }
  }
  return dup;
}

/** A name that no port has yet: "Port 5" if taken becomes "Port 5 (2)" ... */
export function freeName(ports: readonly EditorPort[], wanted: string): string {
  const taken = new Set(ports.flatMap((p) => [p.name, ...p.aliases]).map((n) => n.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${wanted} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted} (${Date.now()})`;
}

export function newPort(ports: readonly EditorPort[], kind: SwitchPortKind, at: { x: number; y: number }): EditorPort {
  const size = ports.find((p) => p.kind === kind) ?? ports[ports.length - 1];
  const w = size?.w ?? 0.012;
  const h = size?.h ?? 0.3;
  return {
    uid: newUid(),
    name: freeName(ports, `Port ${ports.length + 1}`),
    aliases: [],
    kind,
    x: clamp(at.x - w / 2, 0, 1 - w),
    y: clamp(at.y - h / 2, 0, 1 - h),
    w,
    h,
  };
}

// ---- undo ----

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
}

export const HISTORY_LIMIT = 100;

export function startHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** A new present; the old one can be undone. A change that is the same as the present is not a step. */
export function commit<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  const [next, ...rest] = h.future;
  if (next === undefined) return h;
  return { past: [...h.past, h.present], present: next, future: rest };
}
