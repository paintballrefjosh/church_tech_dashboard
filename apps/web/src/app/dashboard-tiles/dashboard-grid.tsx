"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import { LayoutDashboard, Plus, Pencil, Check, RotateCcw } from "lucide-react";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  TILE_CATALOGUE,
  findTile,
  resolveTileConfig,
  type Note,
  type Ticket,
  type TilePlacement,
  type WikiPage,
} from "@church/shared";

export interface DashboardInitialData {
  tickets?: Ticket[];
  notes?: Note[];
  wikiPages?: WikiPage[];
}
import { TileShell } from "./tile-shell";
import {
  TicketsSummaryTile,
  NotesRecentTile,
  WikiRecentTile,
  QuickLinksTile,
  MonitoringOverviewTile,
  PlanningCenterNextServiceTile,
  MyChecklistsTile,
} from "./tiles";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ReactGridLayout = WidthProvider(GridLayout);
const COLS = 12;
const ROW_HEIGHT = 60;

/** Tiles rendered as a header-less full-bleed count button (see TileShell). */
const BUTTON_TILES = new Set(["tickets.summary", "notes.recent", "wiki.recent"]);

function renderTile(id: string, config: Record<string, unknown>, initialData: DashboardInitialData) {
  switch (id) {
    case "tickets.summary":
      return <TicketsSummaryTile initialTickets={initialData.tickets} />;
    case "notes.recent":
      return <NotesRecentTile initialNotes={initialData.notes} />;
    case "wiki.recent":
      return <WikiRecentTile initialPages={initialData.wikiPages} />;
    case "quick.links":
      return <QuickLinksTile />;
    // Legacy monitoring tile ids fold into the consolidated overview so older
    // saved layouts keep rendering something sensible instead of dropping out.
    case "monitoring.overview":
    case "monitoring.summary":
    case "infra.summary":
    case "network.summary":
      return <MonitoringOverviewTile />;
    case "planning_center.next_service":
      return <PlanningCenterNextServiceTile />;
    case "checklists.my_open_tasks":
      return <MyChecklistsTile limit={asInt(config.limit, 5)} />;
    default:
      return <p className="text-xs text-slate-500">Unknown tile id: {id}</p>;
  }
}

/**
 * Section a tile's header links to, so clicking the title opens the full view
 * (replaces the per-tile "All … →" footer links). Quick links has no single
 * destination, so it stays a plain heading.
 */
function tileHref(tileId: string): string | undefined {
  switch (tileId) {
    case "tickets.summary":
      return "/tickets";
    case "notes.recent":
      return "/notes";
    case "wiki.recent":
      return "/wiki";
    case "monitoring.overview":
    case "monitoring.summary":
    case "infra.summary":
    case "network.summary":
      return "/monitoring";
    case "planning_center.next_service":
      return "/planning-center";
    case "checklists.my_open_tasks":
      return "/checklists";
    default:
      return undefined;
  }
}

function asInt(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * One row in the dashboard layout uses a synthetic id so multiple instances of
 * the same tile type can coexist. tileId + indexInLayout disambiguates them.
 */
interface Item {
  i: string;          // react-grid-layout item id, "tileId#index"
  tileId: string;     // catalogue id
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
  config?: Record<string, string | number | boolean>;
}

function toItems(layout: TilePlacement[]): Item[] {
  const counters = new Map<string, number>();
  const out: Item[] = [];
  for (const p of layout) {
    const def = findTile(p.tileId);
    if (!def) continue;
    const idx = counters.get(p.tileId) ?? 0;
    counters.set(p.tileId, idx + 1);
    out.push({
      i: `${p.tileId}#${idx}`,
      tileId: p.tileId,
      x: p.x,
      y: p.y,
      w: p.w,
      h: p.h,
      minW: def.minW,
      minH: def.minH,
      config: p.config,
    });
  }
  return out;
}

function itemsToLayout(items: Item[]): TilePlacement[] {
  return items.map(({ tileId, x, y, w, h, config }) => ({
    tileId,
    x,
    y,
    w,
    h,
    ...(config && Object.keys(config).length ? { config } : {}),
  }));
}

export function DashboardGrid({
  initialLayout,
  access = {},
  initialData = {},
}: {
  initialLayout: TilePlacement[];
  /** Module-access map from the signed-in user; used to filter the tile picker. */
  access?: Record<string, "user" | "moderator" | "admin">;
  /** Pre-fetched payloads for tiles that benefit from a hydration-time render. */
  initialData?: DashboardInitialData;
}) {
  // Only seed tiles the user can actually use. A module-bound tile (tickets /
  // notes / wiki / monitoring / …) needs access to that module; module-less
  // tiles (quick links) are universal. This filters the saved/default layout
  // so a limited user never sees tiles for modules they have no access to —
  // the same rule the picker below applies.
  // The three separate monitoring tiles were consolidated into one
  // `monitoring.overview`. Fold any legacy ids in a saved layout into a single
  // overview tile (kept at the first one's position) so old layouts migrate
  // cleanly on next render/save instead of leaving holes.
  const LEGACY_MONITORING = new Set(["monitoring.summary", "infra.summary", "network.summary"]);
  const rawSeed = initialLayout.length ? initialLayout : DEFAULT_DASHBOARD_LAYOUT;
  const migrated: TilePlacement[] = [];
  let haveOverview = false;
  for (const p of rawSeed) {
    if (LEGACY_MONITORING.has(p.tileId) || p.tileId === "monitoring.overview") {
      if (haveOverview) continue; // collapse duplicates
      migrated.push({ ...p, tileId: "monitoring.overview" });
      haveOverview = true;
    } else {
      migrated.push(p);
    }
  }
  const seed = migrated.filter((p) => {
    const def = findTile(p.tileId);
    if (!def) return false;
    return def.module ? def.module in access : true;
  });
  const [items, setItems] = useState<Item[]>(() => toItems(seed));
  const [editMode, setEditMode] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Debounced save: writes 600ms after the last change.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((next: Item[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaveStatus("saving");
      const res = await fetch("/api/dashboard/layout", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ layout: itemsToLayout(next) }),
        credentials: "same-origin",
      });
      if (res.ok) {
        setSaveStatus("saved");
        setTimeout(() => setSaveStatus("idle"), 1200);
      } else {
        setSaveStatus("error");
      }
    }, 600);
  }, []);
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  const onLayoutChange = useCallback(
    (next: Layout[]) => {
      // Merge positions back into our items. react-grid-layout doesn't carry
      // our extra metadata so we have to look up tileId/min by item id.
      const byId = new Map(items.map((i) => [i.i, i]));
      const merged: Item[] = next.map((l) => {
        const prev = byId.get(l.i);
        if (!prev) return null as never;
        return { ...prev, x: l.x, y: l.y, w: l.w, h: l.h };
      }).filter(Boolean);
      // Only persist if positions/sizes actually changed (react-grid-layout
      // fires onLayoutChange on mount with the same values).
      const changed = JSON.stringify(items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }))) !==
        JSON.stringify(merged.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })));
      if (!changed) return;
      setItems(merged);
      persist(merged);
    },
    [items, persist],
  );

  function addTile(tileId: string) {
    const def = findTile(tileId);
    if (!def) return;
    // Find next free spot at the bottom; simplest: maxY + 1, x=0.
    const maxY = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    const sameKindCount = items.filter((i) => i.tileId === tileId).length;
    const next: Item[] = [
      ...items,
      {
        i: `${tileId}#${sameKindCount}`,
        tileId,
        x: 0,
        y: maxY,
        w: def.defaultW,
        h: def.defaultH,
        minW: def.minW,
        minH: def.minH,
      },
    ];
    setItems(next);
    persist(next);
    setPickerOpen(false);
  }

  function removeTile(itemId: string) {
    const next = items.filter((it) => it.i !== itemId);
    setItems(next);
    persist(next);
  }

  function setItemConfig(itemId: string, config: Record<string, string | number | boolean>) {
    const next = items.map((it) => (it.i === itemId ? { ...it, config } : it));
    setItems(next);
    persist(next);
  }

  async function resetLayout() {
    if (!confirm("Reset to the default dashboard layout?")) return;
    const res = await fetch("/api/dashboard/layout", { method: "DELETE", credentials: "same-origin" });
    if (res.ok) setItems(toItems(DEFAULT_DASHBOARD_LAYOUT));
  }

  const layout = useMemo<Layout[]>(
    () =>
      items.map((it) => ({
        i: it.i,
        x: it.x,
        y: it.y,
        w: it.w,
        h: it.h,
        minW: it.minW,
        minH: it.minH,
      })),
    [items],
  );

  return (
    <div>
      <header className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold">
          <LayoutDashboard className="h-6 w-6 text-brand-600" aria-hidden />
          Dashboard
        </h1>
        <div className="ml-auto flex items-center gap-2 text-sm">
          {saveStatus === "saving" ? (
            <span className="text-xs text-slate-500">Saving…</span>
          ) : saveStatus === "saved" ? (
            <span className="text-xs text-emerald-600">Saved</span>
          ) : saveStatus === "error" ? (
            <span className="text-xs text-rose-600">Save failed</span>
          ) : null}
          {editMode ? (
            <>
              <button
                type="button"
                onClick={() => setPickerOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Plus className="h-4 w-4" aria-hidden /> Add tile
              </button>
              <button
                type="button"
                onClick={resetLayout}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <RotateCcw className="h-4 w-4" aria-hidden /> Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditMode(false);
                  setPickerOpen(false);
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700"
              >
                <Check className="h-4 w-4" aria-hidden /> Done
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Pencil className="h-4 w-4" aria-hidden /> Customise
            </button>
          )}
        </div>
      </header>

      {editMode && pickerOpen ? (
        <div className="mb-4 rounded-lg border border-slate-300 p-3 dark:border-slate-800">
          <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Available tiles</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TILE_CATALOGUE
              // Hide tiles whose underlying module the user can't access at
              // any tier — no point letting them add a Tickets tile if they
              // can't view tickets at all. Tiles without a `module` (e.g.
              // quick links) are universal.
              .filter((t) => !t.module || t.module in access)
              .map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => addTile(t.id)}
                    className="w-full rounded-md border border-slate-300 px-3 py-2 text-left hover:border-brand-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  >
                    <div className="text-sm font-medium">{t.title}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{t.description}</div>
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No tiles yet.{" "}
          <button
            type="button"
            onClick={() => {
              setEditMode(true);
              setPickerOpen(true);
            }}
            className="text-brand-600 underline"
          >
            Add one
          </button>
          .
        </p>
      ) : (
        <ReactGridLayout
          className="layout"
          layout={layout}
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          isDraggable={editMode}
          isResizable={editMode}
          draggableHandle=".tile-drag-handle"
          draggableCancel=".tile-no-drag"
          margin={[12, 12]}
          containerPadding={[0, 0]}
          onLayoutChange={onLayoutChange}
        >
          {items.map((it) => {
            const def = findTile(it.tileId);
            const resolved = resolveTileConfig(it.tileId, it.config);
            return (
              // data-tile-id lets the e2e suite find a tile by id rather than by
              // its title text, which also appears in the nav.
              <div key={it.i} data-tile-id={it.tileId}>
                <TileShell
                  title={def?.title ?? it.tileId}
                  titleHref={tileHref(it.tileId)}
                  editMode={editMode}
                  variant={BUTTON_TILES.has(it.tileId) ? "button" : "panel"}
                  configFields={def?.configFields}
                  configValue={resolved}
                  onConfigChange={(next) => setItemConfig(it.i, next)}
                  onRemove={() => removeTile(it.i)}
                >
                  {renderTile(it.tileId, resolved, initialData)}
                </TileShell>
              </div>
            );
          })}
        </ReactGridLayout>
      )}
    </div>
  );
}
