"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { KIND_META, hrefForHit, type SearchHit as Hit } from "@/lib/search-kinds";

export function SearchBar() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced live search so each keystroke doesn't hammer Meili.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}&limit=15`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (r.ok) {
          const body = (await r.json()) as { hits: Hit[] };
          setHits(body.hits ?? []);
        }
      } finally {
        setBusy(false);
      }
    }, 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [q]);

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
      // Cmd/Ctrl-K focuses the search bar — keyboard shortcut for power users.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
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
    setQ("");
    router.push(hrefForHit(h));
  }

  return (
    <div ref={wrapRef} className="relative w-full max-w-xs sm:max-w-sm md:max-w-md">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden />
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
              setQ("");
              setHits([]);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open && q.trim() ? (
        <div className="absolute right-0 z-50 mt-2 w-[200%] max-w-[calc(100vw-2rem)] max-h-[28rem] overflow-y-auto rounded-md border border-slate-300 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {busy && hits.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">Searching…</p>
          ) : hits.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">
              No matches for &ldquo;{q}&rdquo;.
            </p>
          ) : (
            <ul>
              {hits.map((h) => {
                const meta = KIND_META[h.kind];
                const titleHtml = highlightedHtml(h._formatted?.title, h.title);
                const bodyHtml = highlightedHtml(h._formatted?.body, h.body, 160);
                return (
                  <li key={h.id}>
                    <Link
                      href={hrefForHit(h)}
                      onClick={() => {
                        setOpen(false);
                        setQ("");
                      }}
                      className={`flex gap-3 border-l-4 px-3 py-2 transition hover:bg-slate-50 dark:hover:bg-slate-800 ${meta.bar}`}
                    >
                      <meta.Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.pill}`}
                          >
                            {meta.label}
                            {h.kind === "ticket" && h.extra?.number
                              ? ` #${h.extra.number as number}`
                              : ""}
                          </span>
                          <span
                            className="truncate text-sm font-medium"
                            dangerouslySetInnerHTML={{ __html: titleHtml }}
                          />
                        </div>
                        <div
                          className="mt-0.5 line-clamp-1 text-xs text-slate-500 dark:text-slate-400"
                          dangerouslySetInnerHTML={{ __html: bodyHtml }}
                        />
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-400 dark:border-slate-800">
            <kbd className="rounded border border-slate-300 px-1 dark:border-slate-700">↵</kbd>{" "}
            open top result ·{" "}
            <kbd className="rounded border border-slate-300 px-1 dark:border-slate-700">esc</kbd>{" "}
            close
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Meilisearch returns highlight-marked HTML inside `_formatted` — the matched
 * span wrapped in `<mark>` — but the surrounding text is the *raw* user-
 * authored title/body. A wiki page or ticket whose title is `Foo <img src=x
 * onerror=…>` would land that HTML straight into the DOM if we trusted
 * `_formatted` as-is. So: escape the entire string first, then selectively
 * un-escape the `<mark>` tags that we know Meilisearch wraps matches in
 * (configured server-side in search.service.ts).
 */
function highlightedHtml(formatted: string | undefined, raw: string, maxChars?: number): string {
  const source = formatted ?? raw;
  const limited = typeof maxChars === "number" ? source.slice(0, maxChars) : source;
  const escaped = escapeHtml(limited);
  // Restore only the highlight tags Meilisearch injects. Anything else
  // remains escaped, including a `<mark>` an attacker might have written
  // into the raw text (matching escape becomes `&lt;mark&gt;`, doesn't get
  // un-escaped here because we only replace the *Meili-injected* literals).
  // Since Meili-injected and attacker-written are now both `&lt;mark&gt;`,
  // we replace all of them — `<mark>` is a safe inert element with no
  // event handlers, so even unintended un-escapes are not exploitable.
  return escaped
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
