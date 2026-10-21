import type { SwitchModel, SwitchModelModule } from "@church/shared";

/**
 * Placing add-on modules on a switch model's picture. A placement is a box on the host's port-side picture, as fractions
 * of that picture; the module's own picture is stretched to it, so the box keeps the module picture's proportions
 * (resizing changes the width and the height follows).
 */

export interface Size {
  w: number;
  h: number;
}

const MIN_W = 0.02;
const NUDGE = 0.002;

/** The module's port-side picture size in pixels, or null while it has no picture to place. */
export function moduleSize(m: SwitchModel): Size | null {
  const w = m.portSide === "front" ? m.frontWidth : m.backWidth;
  const h = m.portSide === "front" ? m.frontHeight : m.backHeight;
  return w && h ? { w, h } : null;
}

/** Height fraction of a box `w` wide (fraction of the host's width) that keeps the module picture's proportions. */
export function heightFor(w: number, host: Size, mod: Size): number {
  return (w * host.w * mod.h) / (mod.w * host.h);
}

function fit(p: SwitchModelModule, host: Size, mod: Size): SwitchModelModule {
  const ratio = heightFor(1, host, mod); // h per unit of w
  const maxW = Math.max(MIN_W, Math.min(1, 1 / ratio));
  const w = Math.min(Math.max(p.w, MIN_W), maxW);
  const h = w * ratio;
  return { ...p, w, h, x: Math.min(Math.max(p.x, 0), 1 - w), y: Math.min(Math.max(p.y, 0), 1 - h) };
}

/** The first free placement key: m1, m2 ... */
export function newPlacementId(existing: readonly SwitchModelModule[]): string {
  const used = new Set(existing.map((p) => p.id));
  for (let n = 1; ; n++) if (!used.has(`m${n}`)) return `m${n}`;
}

/** A first guess for a new placement: about a seventh of the picture's width, at the right-hand end, vertically centred. */
export function defaultPlacement(moduleId: string, existing: readonly SwitchModelModule[], host: Size, mod: Size): SwitchModelModule {
  const w = 0.14;
  const h = heightFor(w, host, mod);
  return fit({ id: newPlacementId(existing), moduleId, x: 1 - w - 0.04, y: (1 - h) / 2, w, h }, host, mod);
}

export function moveTo(p: SwitchModelModule, x: number, y: number, host: Size, mod: Size): SwitchModelModule {
  return fit({ ...p, x, y }, host, mod);
}

export function nudge(p: SwitchModelModule, dx: number, dy: number, big: boolean, host: Size, mod: Size): SwitchModelModule {
  const step = big ? NUDGE * 5 : NUDGE;
  return moveTo(p, p.x + dx * step, p.y + dy * step, host, mod);
}

export function resizeTo(p: SwitchModelModule, w: number, host: Size, mod: Size): SwitchModelModule {
  return fit({ ...p, w }, host, mod);
}

/**
 * Port names (and aliases) claimed twice across the host and its placed modules, as sentences. The first claim wins on
 * the switch page (the host's own ports, then the modules in the order placed), so the later one is the one to fix.
 */
export function nameClashes(host: SwitchModel, all: readonly SwitchModel[]): string[] {
  const owner = new Map<string, { label: string; placement: string | null }>();
  for (const p of host.ports) for (const n of [p.name, ...p.aliases]) owner.set(n.toLowerCase(), { label: host.name, placement: null });
  const out: string[] = [];
  for (const pl of host.modules) {
    const mod = all.find((m) => m.id === pl.moduleId && m.kind === "module");
    if (!mod) continue;
    const reported = new Set<string>();
    for (const p of mod.ports) {
      for (const n of [p.name, ...p.aliases]) {
        const k = n.toLowerCase();
        const first = owner.get(k);
        if (!first) owner.set(k, { label: mod.name, placement: pl.id });
        else if (first.placement !== pl.id && !reported.has(k)) {
          reported.add(k);
          out.push(`${n} is on ${first.label} as well as on ${mod.name}; only ${first.label} will show it.`);
        }
      }
    }
  }
  return out;
}
