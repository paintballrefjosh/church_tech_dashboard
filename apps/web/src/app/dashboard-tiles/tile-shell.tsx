"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { TileConfigField } from "@church/shared";
import { TileConfigPopover } from "./tile-config-popover";

/**
 * Common chrome wrapping every tile so they share the same border, padding,
 * title bar, drag handle, settings cog, and "remove" affordance.
 *
 *  - The title bar itself is the drag handle (tile-drag-handle class) so
 *    react-grid-layout picks the tile up when you grab the header.
 *  - The cog is rendered whenever a tile has configFields, even outside edit
 *    mode — config tweaks are non-destructive and a frequent action.
 *  - The X (remove) only renders in edit mode since deleting a tile is a
 *    layout-management action.
 */
export function TileShell({
  title,
  titleHref,
  editMode,
  variant = "panel",
  configFields,
  configValue,
  onConfigChange,
  onRemove,
  children,
}: {
  title: string;
  titleHref?: string;
  editMode: boolean;
  /** "button" = header-less; the child fills the whole tile as one big button. */
  variant?: "panel" | "button";
  configFields?: TileConfigField[];
  configValue?: Record<string, string | number | boolean>;
  onConfigChange?: (next: Record<string, string | number | boolean>) => void;
  onRemove?: () => void;
  children: ReactNode;
}) {
  const hasConfig = Boolean(configFields && configFields.length > 0 && onConfigChange);

  // Button tiles have no header: the whole tile is the child (a coloured
  // count-card link). In edit mode the whole tile becomes the drag handle and
  // the child is made click-through so a grab doesn't navigate; a small remove
  // control is overlaid.
  if (variant === "button") {
    return (
      <div className={`relative h-full w-full ${editMode ? "tile-drag-handle cursor-move" : ""}`}>
        <div className={editMode ? "pointer-events-none h-full w-full" : "h-full w-full"}>
          {children}
        </div>
        {editMode && onRemove ? (
          <button
            type="button"
            className="tile-no-drag absolute right-1.5 top-1.5 z-10 rounded-full bg-black/40 p-1 text-white hover:bg-black/60"
            aria-label={`Remove ${title}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            <span className="block h-3.5 w-3.5 text-center text-xs leading-[0.9]">×</span>
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header
        className={`tile-drag-handle flex shrink-0 items-center justify-between gap-1 border-b border-slate-300 px-3 py-2 text-sm font-semibold dark:border-slate-800 ${
          editMode ? "cursor-move bg-slate-50 dark:bg-slate-800" : ""
        }`}
      >
        {titleHref && !editMode ? (
          // The title itself is the "open this section" affordance, so tiles no
          // longer each carry a redundant "All … →" footer link. tile-no-drag so
          // a click navigates rather than starting a drag.
          <Link
            href={titleHref}
            className="tile-no-drag group inline-flex min-w-0 items-center gap-1 truncate hover:text-brand-600 dark:hover:text-brand-400"
          >
            <span className="truncate">{title}</span>
            <ChevronRight
              className="h-3.5 w-3.5 shrink-0 opacity-0 transition group-hover:opacity-100"
              aria-hidden
            />
          </Link>
        ) : (
          <span className="truncate">{title}</span>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          {hasConfig ? (
            <TileConfigPopover
              fields={configFields!}
              value={configValue ?? {}}
              onChange={(next) => onConfigChange!(next)}
            />
          ) : null}
          {editMode && onRemove ? (
            <button
              type="button"
              // tile-no-drag tells react-grid-layout (via draggableCancel) that
              // mouse-down on this element starts a click, not a drag. We also
              // stop propagation as a belt-and-braces against any DnD library
              // that listens on the parent's mousedown directly.
              className="tile-no-drag rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
              aria-label={`Remove ${title}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
            >
              ×
            </button>
          ) : null}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}
