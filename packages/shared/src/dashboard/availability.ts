import type { AreaKey, AvailabilityGrid } from "./home";

/** One stored hour of one system, as the availability store returns it. */
export interface AvailabilityRow {
  kind: string;
  ref: string;
  label: string;
  /** ISO string of the UTC hour start. */
  hour: string;
  samples: number;
  down: number;
}

export type AvailabilityCell = AvailabilityGrid["groups"][number]["systems"][number]["cells"][number];

const HOUR_MS = 3_600_000;

/** Which area a kind of system belongs to, in display order, with its label and page. */
export const AVAILABILITY_AREAS: ReadonlyArray<{
  area: AreaKey;
  kind: string;
  label: string;
  href: string;
  detailHref: ((ref: string) => string) | null;
}> = [
  { area: "servers", kind: "infra_target", label: "Servers", href: "/monitoring/infra", detailHref: (r) => `/monitoring/infra/${encodeURIComponent(r)}` },
  { area: "internet", kind: "monitor", label: "Internet", href: "/monitoring", detailHref: (r) => `/monitoring/${encodeURIComponent(r)}` },
  { area: "wifi", kind: "unifi_device", label: "Wi-Fi and network", href: "/monitoring/network", detailHref: null },
  { area: "switches", kind: "cisco_switch", label: "Switches", href: "/monitoring/network-cisco", detailHref: null },
  { area: "dns", kind: "dns_node", label: "DNS", href: "/dns", detailHref: null },
  { area: "services", kind: "service_instance", label: "Services", href: "/monitoring/infra/service-groups", detailHref: null },
];

/** Start of the UTC hour containing `at`, in milliseconds. */
export function utcHourStartMs(at: Date): number {
  return Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;
}

/** One cell: no samples is "none", down for half or more of them is "down", some down is "partial". */
export function availabilityCell(samples: number, down: number): AvailabilityCell {
  if (samples <= 0) return "none";
  if (down <= 0) return "up";
  return down * 2 >= samples ? "down" : "partial";
}

/**
 * Turns stored hourly rows into the grid the home page draws: `hours` newest first, groups in
 * area order (empty ones omitted), systems by label, each with one cell per hour (newest first).
 * A system with no samples in the window is left out.
 */
export function bucketAvailability(
  rows: readonly AvailabilityRow[],
  opts: { now: Date; hours: number; kinds: readonly string[] },
): AvailabilityGrid {
  const end = utcHourStartMs(opts.now);
  const starts = Array.from({ length: opts.hours }, (_, i) => end - i * HOUR_MS);
  const index = new Map(starts.map((s, i) => [s, i]));
  const allowed = new Set(opts.kinds);

  interface Acc {
    label: string;
    labelAt: number;
    samples: number[];
    down: number[];
    total: number;
  }
  const byKind = new Map<string, Map<string, Acc>>();
  for (const r of rows) {
    if (!allowed.has(r.kind)) continue;
    const at = Date.parse(r.hour);
    const i = index.get(Math.floor(at / HOUR_MS) * HOUR_MS);
    if (i === undefined || !(r.samples > 0)) continue;
    let systems = byKind.get(r.kind);
    if (!systems) byKind.set(r.kind, (systems = new Map()));
    let acc = systems.get(r.ref);
    if (!acc) {
      acc = {
        label: r.label,
        labelAt: at,
        samples: new Array<number>(opts.hours).fill(0),
        down: new Array<number>(opts.hours).fill(0),
        total: 0,
      };
      systems.set(r.ref, acc);
    }
    acc.samples[i]! += r.samples;
    acc.down[i]! += r.down;
    acc.total += r.samples;
    if (at >= acc.labelAt) {
      acc.label = r.label;
      acc.labelAt = at;
    }
  }

  const groups: AvailabilityGrid["groups"] = [];
  for (const meta of AVAILABILITY_AREAS) {
    const systems = byKind.get(meta.kind);
    if (!systems) continue;
    const list = [...systems.entries()]
      .filter(([, a]) => a.total > 0)
      .map(([ref, a]) => ({
        ref,
        name: a.label,
        href: meta.detailHref ? meta.detailHref(ref) : meta.href,
        cells: a.samples.map((s, i) => availabilityCell(s, a.down[i]!)),
      }))
      .sort((x, y) => x.name.localeCompare(y.name) || x.ref.localeCompare(y.ref));
    if (list.length === 0) continue;
    groups.push({ area: meta.area, label: meta.label, href: meta.href, systems: list });
  }
  return { hours: starts.map((s) => new Date(s).toISOString()), groups };
}
