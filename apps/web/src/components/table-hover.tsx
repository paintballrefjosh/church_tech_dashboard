"use client";

import { useRef, type ReactNode } from "react";

/**
 * Wrapper for rendered wiki markdown that lights up the cell under the pointer
 * together with its row and column, so a wide table is easy to read across.
 *
 * Cell and row are plain CSS (:hover, see globals.css). A column is not a CSS
 * ancestor of its cells, so this marks the cells of the hovered column with
 * `data-col-hl`. It edits attributes directly on the server-rendered DOM and
 * never re-renders the markdown, so nothing here costs a React update per move.
 */
export function TableHover({ className, children }: { className?: string; children: ReactNode }) {
  const lit = useRef<{ table: HTMLTableElement; index: number } | null>(null);

  function clear() {
    const cur = lit.current;
    if (!cur) return;
    for (const row of Array.from(cur.table.rows)) row.cells[cur.index]?.removeAttribute("data-col-hl");
    lit.current = null;
  }

  function onOver(e: React.MouseEvent<HTMLDivElement>) {
    const cell = (e.target as Element).closest<HTMLTableCellElement>("td, th");
    const table = cell?.closest("table");
    if (!cell || !table) return clear();
    if (lit.current?.table === table && lit.current.index === cell.cellIndex) return;
    clear();
    for (const row of Array.from(table.rows)) row.cells[cell.cellIndex]?.setAttribute("data-col-hl", "");
    lit.current = { table, index: cell.cellIndex };
  }

  return (
    <div data-table-hover className={className} onMouseOver={onOver} onMouseLeave={clear}>
      {children}
    </div>
  );
}
