import { z } from "zod";

/**
 * Rooms (docs/assets.md). One list of places used by tickets, assets, cabinets, monitors, infra hosts and printers. The
 * API calls them locations (`/locations`), the UI says "room". Everyone signed in reads them; `locations:admin` edits them.
 */

export const createLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    /** Groups the list ("Main building", "Annex"); optional. */
    building: z.string().trim().max(120).default(""),
    notes: z.string().max(4000).default(""),
  })
  .strict();
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export const updateLocationSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    building: z.string().trim().max(120).optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export interface Location {
  id: string;
  name: string;
  building: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

/** A room as other things carry it. */
export interface LocationRef {
  id: string;
  name: string;
}

/** How many things point at a room (what deleting it would clear). */
export interface LocationUsage {
  tickets: number;
  assets: number;
  racks: number;
  monitors: number;
  hosts: number;
  printers: number;
}

/**
 * What the room page shows. Each section is present only when the reader may see that kind of thing (assets with
 * `assets:read:any`, cabinets/monitors/hosts with `monitors:read:any`, printers with `printers:read:any`); tickets are only
 * those the reader can read. Absent means "not yours to see", empty means "nothing here".
 */
export interface LocationSummary {
  location: Location;
  assets?: Array<{ id: string; tag: string; name: string; status: string; holderName: string | null }>;
  racks?: Array<{ id: string; name: string }>;
  monitors?: Array<{ id: string; name: string; status: string }>;
  hosts?: Array<{ id: string; name: string; status: string }>;
  printers?: Array<{ id: string; name: string }>;
  tickets?: Array<{ id: string; number: number; title: string; status: string; priority: string }>;
}

/** "Sanctuary (Main building)", or just the name. */
export function locationLabel(l: Pick<Location, "name" | "building">): string {
  return l.building ? `${l.name} (${l.building})` : l.name;
}

/** Rooms grouped by building (rooms with none first), each group and room by name. */
export function groupLocations<T extends Pick<Location, "name" | "building">>(list: readonly T[]): Array<{ building: string; rooms: T[] }> {
  const by = new Map<string, T[]>();
  for (const l of list) {
    const k = l.building.trim();
    const g = by.get(k);
    if (g) g.push(l);
    else by.set(k, [l]);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([building, rooms]) => ({ building, rooms: [...rooms].sort((a, b) => a.name.localeCompare(b.name)) }));
}
