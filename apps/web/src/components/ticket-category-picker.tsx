"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { TagBadge, type TagLike } from "./tag-badge";

interface CategoryRecord extends TagLike {
  createdAt: string;
}

/**
 * Picker for the admin-curated ticket-category catalogue. Same chip shape as
 * the tag picker but does NOT allow inline creation — only existing entries
 * can be assigned. If `canEdit` is false the picker renders read-only chips.
 */
export function TicketCategoryPicker({
  value,
  onChange,
  canEdit = true,
}: {
  value: TagLike[];
  onChange: (next: TagLike[]) => void;
  canEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<CategoryRecord[]>([]);
  const [filter, setFilter] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  async function loadAll() {
    const r = await fetch("/api/ticket-categories", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setAll((await r.json()) as CategoryRecord[]);
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  function add(c: TagLike) {
    if (value.find((v) => v.id === c.id)) return;
    onChange([...value, c]);
    setFilter("");
  }
  function remove(id: string) {
    onChange(value.filter((c) => c.id !== id));
  }

  const filterLower = filter.trim().toLowerCase();
  const filtered = filterLower
    ? all.filter((c) => c.name.toLowerCase().includes(filterLower))
    : all;
  const visible = filtered.filter((c) => !value.find((v) => v.id === c.id));

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-1">
      {value.map((c) => (
        <TagBadge
          key={c.id}
          tag={c}
          onRemove={canEdit ? () => remove(c.id) : undefined}
        />
      ))}
      {canEdit ? (
        <button
          type="button"
          onClick={() => {
            setOpen((v) => !v);
            if (!open) void loadAll();
          }}
          aria-label="Add category"
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-500 hover:text-slate-900 dark:border-slate-600 dark:hover:border-slate-300 dark:hover:text-slate-200"
        >
          <Plus className="h-3 w-3" aria-hidden /> Category
        </button>
      ) : null}

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-slate-300 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <input
            type="text"
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter…"
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <ul className="mt-1 max-h-48 overflow-y-auto">
            {all.length === 0 ? (
              <li className="p-2 text-center text-[10px] text-slate-500">
                No categories defined. Ask an admin to add some.
              </li>
            ) : visible.length === 0 ? (
              <li className="p-2 text-center text-[10px] text-slate-500">
                {filter ? "No matches." : "All categories already assigned."}
              </li>
            ) : null}
            {visible.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => add(c)}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <TagBadge tag={c} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
