"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookmarkPlus, Bookmark, Trash2 } from "lucide-react";

interface SavedView {
  id: string;
  name: string;
  query: Record<string, string>;
}

/**
 * Saved-views bar for the tickets list. Lists the user's named filter
 * combinations and lets them save the current URL params under a name.
 * Backend is `saved_views` keyed by resourceType=ticket.
 */
export function SavedViewsBar({ resourceType }: { resourceType: "ticket" | "wiki_page" | "note" }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [views, setViews] = useState<SavedView[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/v1/saved-views?resource=${resourceType}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) setViews((await r.json()) as SavedView[]);
      } catch {
        /* non-fatal */
      }
    })();
  }, [resourceType]);

  function apply(view: SavedView) {
    const sp = new URLSearchParams(view.query);
    router.push(`${window.location.pathname}?${sp.toString()}`);
  }

  async function save() {
    const name = window.prompt("Save current filters as…");
    if (!name) return;
    setSaving(true);
    try {
      const query: Record<string, string> = {};
      searchParams.forEach((v, k) => {
        query[k] = v;
      });
      const r = await fetch("/api/v1/saved-views", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ resourceType, name, query }),
      });
      if (r.ok) {
        const created = (await r.json()) as SavedView;
        setViews((vs) => [...vs, created]);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this saved view?")) return;
    const r = await fetch(`/api/v1/saved-views/${id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) setViews((vs) => vs.filter((v) => v.id !== id));
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="uppercase tracking-wide text-slate-500 dark:text-slate-400">Views</span>
      {views.length === 0 ? (
        <span className="text-slate-400">none yet</span>
      ) : (
        views.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1">
            <button
              type="button"
              onClick={() => apply(v)}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-0.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Bookmark className="h-3 w-3" aria-hidden /> {v.name}
            </button>
            <button
              type="button"
              onClick={() => remove(v.id)}
              aria-label={`Delete view ${v.name}`}
              className="text-slate-400 hover:text-rose-600"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))
      )}
      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-300 px-2 py-0.5 text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <BookmarkPlus className="h-3 w-3" aria-hidden /> Save current filters
      </button>
    </div>
  );
}
