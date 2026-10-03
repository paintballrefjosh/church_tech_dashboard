"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { TagBadge, type TagLike } from "./tag-badge";

/**
 * Compact chip strip used above a resource list. Clicking a tag sets it as
 * the active filter; clicking it again clears it. Selected tag is conveyed
 * to the parent via `selectedId` + `onChange`.
 *
 * Server-side, the resource's list endpoint reads `?tagId=<id>` and applies
 * an `EXISTS` subquery against tag_assignments — see TicketsService.list /
 * NotesService.list / WikiService.list.
 */
export function TagFilter({
  selectedId,
  onChange,
}: {
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [all, setAll] = useState<TagLike[]>([]);

  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/tags", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setAll((await r.json()) as TagLike[]);
    })();
  }, []);

  if (all.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Tags
      </span>
      {all.map((t) => {
        const isActive = selectedId === t.id;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(isActive ? null : t.id)}
            className={`rounded-full transition ${
              isActive ? "ring-2 ring-brand-500 ring-offset-1 ring-offset-transparent" : "opacity-70 hover:opacity-100"
            }`}
            aria-pressed={isActive}
            title={isActive ? `Clear ${t.name} filter` : `Filter by ${t.name}`}
          >
            <TagBadge tag={t} />
          </button>
        );
      })}
      {selectedId ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
        >
          <X className="h-3 w-3" aria-hidden /> Clear
        </button>
      ) : null}
    </div>
  );
}
