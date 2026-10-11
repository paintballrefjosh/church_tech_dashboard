"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { hrefForHit } from "@/lib/search-kinds";
import { useGlobalSearch } from "@/lib/use-global-search";
import { SearchResultList } from "@/components/search-results";

/**
 * The global search as a field a page can embed (the Start page puts a large one in its hero).
 * Behaviour only: Enter opens the top result, Escape closes the list, clicking away closes it.
 * Every part takes a `className` so a look can style it; the defaults are plain.
 */
export function SearchField({
  placeholder = "Search everything…",
  autoFocus = false,
  limit = 8,
  className = "",
  inputClassName = "w-full rounded-md border border-slate-300 bg-white py-2 pl-9 pr-9 text-sm dark:border-slate-700 dark:bg-slate-900",
  panelClassName = "absolute left-0 right-0 z-30 mt-2 max-h-[28rem] overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900",
  iconClassName = "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400",
  trailing,
}: {
  placeholder?: string;
  autoFocus?: boolean;
  limit?: number;
  className?: string;
  inputClassName?: string;
  panelClassName?: string;
  iconClassName?: string;
  /** Extra content inside the field's box, after the clear button (a shortcut hint, say). */
  trailing?: ReactNode;
}) {
  const router = useRouter();
  const { q, setQ, hits, busy, clear } = useGlobalSearch({ limit, debounceMs: 150 });
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  function close() {
    setOpen(false);
    clear();
  }

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className={iconClassName} aria-hidden />
        <input
          ref={inputRef}
          type="search"
          value={q}
          autoFocus={autoFocus}
          placeholder={placeholder}
          aria-label="Search everything"
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
            } else if (e.key === "Enter" && hits[0]) {
              e.preventDefault();
              const href = hrefForHit(hits[0]);
              close();
              router.push(href);
            }
          }}
          className={inputClassName}
        />
        {q ? (
          <button
            type="button"
            onClick={() => {
              clear();
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
        {trailing}
      </div>
      {open && q.trim() ? (
        <div className={panelClassName} role="region" aria-label="Search results">
          <SearchResultList hits={hits} query={q} busy={busy} onPick={close} />
        </div>
      ) : null}
    </div>
  );
}
