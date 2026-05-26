"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import GridLayout, { WidthProvider, type Layout } from "react-grid-layout";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  TILE_CATALOGUE,
  findTile,
  type TilePlacement,
} from "@church/shared";
import { TileShell } from "./tile-shell";
import {
  TicketsSummaryTile,
  NotesRecentTile,
  WikiRecentTile,
  QuickLinksTile,
} from "./tiles";

import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

const ReactGridLayout = WidthProvider(GridLayout);
const COLS = 12;
const ROW_HEIGHT = 60;

function renderTile(id: string) {
  switch (id) {
    case "tickets.summary":
      return <TicketsSummaryTile />;
    case "notes.recent":
      return <NotesRecentTile />;
    case "wiki.recent":
      return <WikiRecentTile />;
    case "quick.links":
      return <QuickLinksTile />;
    default:
      return <p className="text-xs text-slate-500">Unknown tile id: {id}</p>;
  }
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
    });
  }
  return out;
}

function itemsToLayout(items: Item[]): TilePlacement[] {
  return items.map(({ tileId, x, y, w, h }) => ({ tileId, x, y, w, h }));
}

export function DashboardGrid({
  initialLayout,
}: {
  initialLayout: TilePlacement[];
}) {
  const seed = initialLayout.length ? initialLayout : DEFAULT_DASHBOARD_LAYOUT;
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
        <h1 className="text-2xl font-semibold">Dashboard</h1>
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
                className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                + Add tile
              </button>
              <button
                type="button"
                onClick={resetLayout}
                className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditMode(false);
                  setPickerOpen(false);
                }}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700"
              >
                Done
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditMode(true)}
              className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Customise
            </button>
          )}
        </div>
      </header>

      {editMode && pickerOpen ? (
        <div className="mb-4 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <p className="mb-2 text-xs uppercase tracking-wide text-slate-500">Available tiles</p>
          <ul className="grid gap-2 sm:grid-cols-2">
            {TILE_CATALOGUE.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => addTile(t.id)}
                  className="w-full rounded-md border border-slate-200 px-3 py-2 text-left hover:border-brand-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
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
          {items.map((it) => (
            <div key={it.i}>
              <TileShell
                title={findTile(it.tileId)?.title ?? it.tileId}
                editMode={editMode}
                onRemove={() => removeTile(it.i)}
              >
                {renderTile(it.tileId)}
              </TileShell>
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
