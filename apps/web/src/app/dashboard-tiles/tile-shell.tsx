"use client";

import type { ReactNode } from "react";

/**
 * Common chrome wrapping every tile so they share the same border, padding,
 * title bar, and "remove" affordance. The drag handle is the title bar itself
 * via the `tile-drag-handle` class react-grid-layout is configured to use.
 */
export function TileShell({
  title,
  editMode,
  onRemove,
  children,
}: {
  title: string;
  editMode: boolean;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <header
        className={`tile-drag-handle flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-2 text-sm font-semibold dark:border-slate-800 ${
          editMode ? "cursor-move bg-slate-50 dark:bg-slate-800" : ""
        }`}
      >
        <span className="truncate">{title}</span>
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
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
    </div>
  );
}
