import { z } from "zod";

/**
 * Per-tile config field descriptor. Tile definitions enumerate the user-tunable
 * knobs here; the dashboard UI renders a generic form from these so each tile
 * doesn't have to ship its own settings panel.
 */
export interface TileConfigField {
  key: string;
  type: "number" | "boolean";
  label: string;
  description?: string;
  /** Inclusive bounds for `type: "number"`. */
  min?: number;
  max?: number;
  defaultValue: number | boolean;
}

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
  /**
   * The module this tile belongs to. The tile only renders / appears in the
   * picker when the user has access to that module (any tier). Tiles with no
   * `module` are universal (e.g. quick links).
   */
  module?: string;
  /**
   * User-tunable config fields. Edited via the cog on the tile; persisted
   * onto the user's TilePlacement.config.
   */
  configFields?: TileConfigField[];
}

export const TILE_CATALOGUE: readonly TileDefinition[] = [
  // The tickets / notes / wiki tiles are single-count "cards" — a big number
  // that links to the section (see tiles.tsx CountCard) — so they carry no
  // per-item limit config and sit shorter than the list tiles they replaced.
  {
    id: "tickets.summary",
    title: "Tickets",
    description: "Open tickets, at a glance.",
    defaultW: 2,
    defaultH: 3,
    minW: 2,
    minH: 2,
    module: "tickets",
  },
  {
    id: "notes.recent",
    title: "Notes",
    description: "How many notes you have.",
    defaultW: 2,
    defaultH: 3,
    minW: 2,
    minH: 2,
    module: "notes",
  },
  {
    id: "wiki.recent",
    title: "Wiki",
    description: "How many wiki pages exist.",
    defaultW: 2,
    defaultH: 3,
    minW: 2,
    minH: 2,
    module: "wiki",
  },
  {
    id: "quick.links",
    title: "Quick links",
    description: "Create shortcuts.",
    defaultW: 4,
    defaultH: 2,
    minW: 2,
    minH: 2,
  },
  {
    // Consolidated monitoring tile: one row per area (Infrastructure, Services,
    // UniFi, Cisco switches) with a per-area health pill. Replaced the former
    // separate monitoring.summary / infra.summary / network.summary tiles;
    // the dashboard grid folds those legacy ids into this one.
    id: "monitoring.overview",
    title: "Monitoring",
    description: "System health at a glance.",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    module: "monitoring",
  },
  {
    id: "planning_center.next_service",
    title: "Next service",
    description: "Next service and team.",
    defaultW: 6,
    defaultH: 5,
    minW: 4,
    minH: 3,
    module: "planning_center",
  },
  {
    id: "checklists.my_open_tasks",
    title: "My checklists",
    description: "Your open tasks.",
    defaultW: 4,
    defaultH: 4,
    minW: 3,
    minH: 3,
    module: "checklists",
    configFields: [
      {
        key: "limit",
        type: "number",
        label: "Events to show",
        description: "Cap on how many upcoming events with open tasks render.",
        min: 1,
        max: 10,
        defaultValue: 5,
      },
    ],
  },
] as const;

export function findTile(id: string): TileDefinition | undefined {
  return TILE_CATALOGUE.find((t) => t.id === id);
}

/**
 * Resolve a placement's stored config against its tile definition. Returns
 * the explicit value when set, otherwise the field's defaultValue. Used by
 * tile components so they never see `undefined`.
 */
export function resolveTileConfig(
  tileId: string,
  config: Record<string, unknown> | undefined | null,
): Record<string, string | number | boolean> {
  const def = findTile(tileId);
  if (!def?.configFields) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const f of def.configFields) {
    const raw = config?.[f.key];
    const v =
      typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean"
        ? raw
        : f.defaultValue;
    out[f.key] = v;
  }
  return out;
}

export const tilePlacementSchema = z.object({
  tileId: z.string().min(1).max(64),
  x: z.number().int().min(0).max(48),
  y: z.number().int().min(0).max(1000),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(20),
  /**
   * Per-user, per-tile-instance configuration. Free-form key/value bag —
   * the catalogue's configFields describes what's valid; the API stores
   * whatever the client sends (within size limits) so a new tile config
   * doesn't need a migration.
   */
  config: z.record(z.union([z.number(), z.boolean(), z.string()])).optional(),
});
export type TilePlacement = z.infer<typeof tilePlacementSchema>;

export const dashboardLayoutSchema = z.object({
  layout: z.array(tilePlacementSchema).max(50),
});
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;

/** Default layout shown to users who've never customised theirs. */
// Two full-width rows so a fresh dashboard fills the grid instead of leaving a
// dead right-hand column. Module-gated tiles (checklists) are dropped for users
// without that module and the grid compacts, so this degrades cleanly.
export const DEFAULT_DASHBOARD_LAYOUT: TilePlacement[] = [
  // Top-left: three square app-icon-style count buttons. Monitoring fills the
  // top-right; the list/status tiles flow below.
  { tileId: "tickets.summary", x: 0, y: 0, w: 2, h: 3 },
  { tileId: "notes.recent", x: 2, y: 0, w: 2, h: 3 },
  { tileId: "wiki.recent", x: 4, y: 0, w: 2, h: 3 },
  { tileId: "monitoring.overview", x: 6, y: 0, w: 6, h: 4 },
  { tileId: "checklists.my_open_tasks", x: 0, y: 3, w: 6, h: 4 },
  { tileId: "quick.links", x: 6, y: 4, w: 6, h: 2 },
];
