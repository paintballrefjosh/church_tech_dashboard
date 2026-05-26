import { z } from "zod";

/**
 * Catalogue of tiles the dashboard can render. Adding one here makes it
 * available in the tile picker; removing one is forward-compatible — old
 * layout rows referring to a missing tileId are dropped by the renderer.
 *
 * Sizes are columns/rows in the react-grid-layout 12-column grid.
 */
export interface TileDefinition {
  id: string;
  title: string;
  description: string;
  defaultW: number;
  defaultH: number;
  minW: number;
  minH: number;
}

export const TILE_CATALOGUE: readonly TileDefinition[] = [
  {
    id: "tickets.summary",
    title: "My tickets",
    description: "Counts by status + your most recent tickets.",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
  },
  {
    id: "notes.recent",
    title: "Recent notes",
    description: "Your most recently updated notes.",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
  },
  {
    id: "wiki.recent",
    title: "Recent wiki pages",
    description: "Wiki pages updated lately.",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
  },
  {
    id: "quick.links",
    title: "Quick links",
    description: "Shortcuts: new ticket, new note, new wiki page.",
    defaultW: 4,
    defaultH: 2,
    minW: 2,
    minH: 2,
  },
] as const;

export function findTile(id: string): TileDefinition | undefined {
  return TILE_CATALOGUE.find((t) => t.id === id);
}

export const tilePlacementSchema = z.object({
  tileId: z.string().min(1).max(64),
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(20),
});
export type TilePlacement = z.infer<typeof tilePlacementSchema>;

export const dashboardLayoutSchema = z.object({
  layout: z.array(tilePlacementSchema).max(50),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** Default layout shown to users who've never customised theirs. */
export const DEFAULT_DASHBOARD_LAYOUT: TilePlacement[] = [
  { tileId: "tickets.summary", x: 0, y: 0, w: 4, h: 4 },
  { tileId: "notes.recent", x: 4, y: 0, w: 4, h: 4 },
  { tileId: "wiki.recent", x: 8, y: 0, w: 4, h: 4 },
  { tileId: "quick.links", x: 0, y: 4, w: 4, h: 2 },
];
