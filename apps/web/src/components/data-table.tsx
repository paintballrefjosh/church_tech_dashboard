"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUp, ArrowDown, ArrowUpDown, Search, ChevronLeft, ChevronRight } from "lucide-react";

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable + included in the text filter. */
  sortValue?: (row: T) => string | number;
  align?: "right";
}

/**
 * When `server` is supplied the table is *controlled*: `rows` is the current
 * page (already fetched/filtered/paged by the parent), `server.total` drives the
 * page count, and search/paging/size changes call back into the parent instead
 * of happening locally. Without it the table filters, sorts, and paginates the
 * full `rows` array client-side.
 */
export interface ServerMode {
  total: number;
  page: number; // 0-based
  pageSize: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSearch: (q: string) => void;
  /** Server-side sort — header clicks call this instead of sorting locally. */
  onSort?: (key: string, dir: "asc" | "desc") => void;
}

/** Generic sortable + filterable + paginated table. */
export function DataTable<T>({
  rows,
  columns,
  getKey,
  initialSort,
  filterPlaceholder = "Filter…",
  rightSlot,
  emptyText = "No matching rows.",
  pageSizeOptions = [25, 50, 100, 200],
  initialPageSize,
  server,
}: {
  rows: T[];
  columns: Column<T>[];
  getKey: (row: T) => string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  filterPlaceholder?: string;
  rightSlot?: ReactNode;
  emptyText?: string;
  pageSizeOptions?: number[];
  initialPageSize?: number;
  server?: ServerMode;
}) {
  const isServer = Boolean(server);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState(initialSort?.key ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSort?.dir ?? "asc");
  const [clientPage, setClientPage] = useState(0);
  const [clientSize, setClientSize] = useState(initialPageSize ?? pageSizeOptions[0] ?? 50);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pageSize = server ? server.pageSize : clientSize;

  // Client-side filter (skipped in server mode — the parent already filtered).
  const filtered = useMemo(() => {
    if (isServer) return rows;
    const f = filter.trim().toLowerCase();
    if (!f) return rows;
    return rows.filter((r) => columns.some((c) => (c.sortValue ? String(c.sortValue(r)).toLowerCase().includes(f) : false)));
  }, [rows, filter, columns, isServer]);

  const sorted = useMemo(() => {
    if (isServer) return rows; // server already sorted the page
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      if (av < bv) return -dir;
      if (av > bv) return dir;
      return 0;
    });
  }, [filtered, rows, isServer, sortKey, sortDir, columns]);

  const total = server ? server.total : sorted.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(server ? server.page : clientPage, pageCount - 1);
  const pageRows = server ? sorted : sorted.slice(page * pageSize, page * pageSize + pageSize);
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = server ? Math.min(total, page * pageSize + pageRows.length) : Math.min(total, (page + 1) * pageSize);

  function goPage(p: number) {
    const clamped = Math.max(0, Math.min(p, pageCount - 1));
    if (server) server.onPageChange(clamped);
    else setClientPage(clamped);
  }
  function setSize(s: number) {
    if (server) server.onPageSizeChange(s);
    else {
      setClientSize(s);
      setClientPage(0);
    }
  }
  function onFilterChange(v: string) {
    setFilter(v);
    if (server) {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      searchTimer.current = setTimeout(() => server.onSearch(v.trim()), 300);
    } else {
      setClientPage(0);
    }
  }
  function toggleSort(key: string) {
    const col = columns.find((c) => c.key === key);
    if (!col?.sortValue) return;
    const nextDir: "asc" | "desc" = sortKey === key && sortDir === "asc" ? "desc" : "asc";
    setSortKey(key);
    setSortDir(nextDir);
    if (server) server.onSort?.(key, nextDir);
    else setClientPage(0);
  }

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-slate-400" aria-hidden />
          <input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder={filterPlaceholder}
            className="w-64 rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </div>
        <span className="text-xs text-slate-400">
          {total === 0 ? "0" : `${start}–${end}`} of {total}
          {server?.loading ? " · loading…" : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {rightSlot}
          <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            Rows
            <select
              value={pageSize}
              onChange={(e) => setSize(Number(e.target.value))}
              className="rounded-md border border-slate-300 px-1.5 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className="inline-flex items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200"
                    >
                      {c.label}
                      {sortKey === c.key ? (
                        sortDir === "asc" ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-40" aria-hidden />
                      )}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-slate-500">
                  {server?.loading ? "Loading…" : emptyText}
                </td>
              </tr>
            ) : (
              pageRows.map((r) => (
                <tr key={getKey(r)} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  {columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right" : ""}`}>
                      {c.render(r)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-end gap-3 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Page {page + 1} of {pageCount}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => goPage(page - 1)}
              disabled={page <= 0}
              className="inline-flex items-center gap-0.5 rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Prev
            </button>
            <button
              type="button"
              onClick={() => goPage(page + 1)}
              disabled={page >= pageCount - 1}
              className="inline-flex items-center gap-0.5 rounded-md border border-slate-300 px-2 py-1 hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              Next <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
