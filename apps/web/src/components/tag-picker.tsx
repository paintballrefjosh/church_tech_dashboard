"use client";

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { TagBadge, type TagLike } from "./tag-badge";

interface AllTag extends TagLike {
  createdAt: string;
}

/**
 * Compact picker used on resource detail pages. Renders the current tags as
 * removable chips with a "+" button that opens a small dropdown to add more
 * (filtered by typed prefix). Optionally lets the user create a brand-new
 * tag inline when `canCreate` is true.
 *
 * The component is uncontrolled w.r.t. the all-tags catalogue (fetched on
 * mount + on dropdown open). Selected tags come from / go to the parent via
 * `value` + `onChange`.
 */
export function TagPicker({
  value,
  onChange,
  canCreate = true,
}: {
  value: TagLike[];
  onChange: (next: TagLike[]) => void;
  canCreate?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState<AllTag[]>([]);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  async function loadAll() {
    const r = await fetch("/api/tags", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setAll((await r.json()) as AllTag[]);
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

  function add(tag: TagLike) {
    if (value.find((t) => t.id === tag.id)) return;
    onChange([...value, tag]);
    setFilter("");
  }
  function remove(id: string) {
    onChange(value.filter((t) => t.id !== id));
  }

  async function createInline(name: string) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/tags", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), color: "slate" }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        setErr(
          Array.isArray(b.message) ? b.message.join(", ") : (b.message ?? `failed (${r.status})`),
        );
        return;
      }
      const tag = (await r.json()) as AllTag;
      setAll((prev) => [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)));
      add(tag);
    } finally {
      setBusy(false);
    }
  }

  const filterLower = filter.trim().toLowerCase();
  const filtered = filterLower
    ? all.filter((t) => t.name.toLowerCase().includes(filterLower))
    : all;
  const visible = filtered.filter((t) => !value.find((v) => v.id === t.id));
  const exactMatch = all.find((t) => t.name.toLowerCase() === filterLower);

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-1">
      {value.map((t) => (
        <TagBadge key={t.id} tag={t} onRemove={() => remove(t.id)} />
      ))}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add tag"
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-xs text-slate-500 hover:border-slate-500 hover:text-slate-900 dark:border-slate-600 dark:hover:border-slate-300 dark:hover:text-slate-200"
      >
        <Plus className="h-3 w-3" aria-hidden /> Tag
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-40 mt-1 w-64 rounded-md border border-slate-300 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <input
            type="text"
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter or create…"
            onKeyDown={(e) => {
              if (e.key === "Enter" && filter.trim() && !exactMatch && canCreate) {
                e.preventDefault();
                void createInline(filter);
              }
            }}
            className="w-full rounded border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          {err ? <p className="mt-1 text-[10px] text-rose-600">{err}</p> : null}
          <ul className="mt-1 max-h-48 overflow-y-auto">
            {visible.length === 0 && !filter ? (
              <li className="p-2 text-center text-[10px] text-slate-500">
                No more tags available.
              </li>
            ) : null}
            {visible.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => add(t)}
                  className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  <TagBadge tag={t} />
                </button>
              </li>
            ))}
            {filter.trim() && !exactMatch && canCreate ? (
              <li>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void createInline(filter)}
                  className="mt-1 flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:hover:bg-brand-900/30"
                >
                  <Plus className="h-3 w-3" aria-hidden /> Create &ldquo;{filter.trim()}&rdquo;
                </button>
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
