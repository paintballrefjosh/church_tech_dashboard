"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { hrefForHit, type SearchHit as Hit } from "@/lib/search-kinds";
import { useGlobalSearch } from "@/lib/use-global-search";
import { SearchResultList } from "@/components/search-results";

export function SearchBar() {
  const router = useRouter();
  const { q, setQ, hits, busy, clear } = useGlobalSearch({ limit: 15, debounceMs: 180 });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click + Esc.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
      // Cmd/Ctrl-K belongs to the command palette (command-palette.tsx), which searches too. This bar used to answer it as
      // well, so both opened at once and focus was left in the bar behind the palette.
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function go(h: Hit) {
    setOpen(false);
    clear();
    router.push(hrefForHit(h));
  }

  return (
    <div ref={wrapRef} className="relative w-full max-w-xs sm:max-w-sm md:max-w-md">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-400" aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={q}
          placeholder="Search everything…"
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              go(hits[0]);
            }
          }}
          className="w-full rounded-md border border-slate-300 bg-white pl-8 pr-8 py-1.5 text-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
          aria-label="Global search"
        />
        {q ? (
          <button
            type="button"
            onClick={() => {
              clear();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open && q.trim() ? (
        <div className="fx-solid absolute right-0 z-50 mt-2 w-[200%] max-w-[calc(100vw-2rem)] max-h-[28rem] overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <SearchResultList
            hits={hits}
            query={q}
            busy={busy}
            onPick={() => {
              setOpen(false);
              clear();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
