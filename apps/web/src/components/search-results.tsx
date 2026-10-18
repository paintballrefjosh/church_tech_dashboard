"use client";

import Link from "next/link";
import { KIND_META, hrefForHit, type SearchHit } from "@/lib/search-kinds";

/**
 * The result list of the global search, with the matched text highlighted. Used by the top bar's
 * dropdown and the home page's search field; the Cmd/Ctrl-K palette lists the same hits through
 * cmdk instead. Renders nothing around the list (no border, no position): the caller wraps it.
 */
export function SearchResultList({
  hits,
  query,
  busy,
  onPick,
  footer = true,
}: {
  hits: SearchHit[];
  query: string;
  busy: boolean;
  /** Called after a result link is followed. */
  onPick?: (hit: SearchHit) => void;
  /** Show the "enter opens the top result" hint. */
  footer?: boolean;
}) {
  if (busy && hits.length === 0) return <p className="p-4 text-center text-xs text-slate-500 dark:text-slate-400">Searching…</p>;
  if (hits.length === 0) {
    return (
      <p className="p-4 text-center text-xs text-slate-500 dark:text-slate-400">No matches for &ldquo;{query}&rdquo;.</p>
    );
  }
  return (
    <>
      <ul>
        {hits.map((h) => {
          const meta = KIND_META[h.kind];
          const titleHtml = highlightedHtml(h._formatted?.title, h.title);
          const bodyHtml = highlightedHtml(h._formatted?.body, h.body, 160);
          return (
            <li key={h.id}>
              <Link
                href={hrefForHit(h)}
                onClick={() => onPick?.(h)}
                className={`flex gap-3 border-l-4 px-3 py-2 transition hover:bg-slate-50 dark:hover:bg-slate-800 ${meta.bar}`}
              >
                <meta.Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.pill}`}
                    >
                      {meta.label}
                      {h.kind === "ticket" && h.extra?.number ? ` #${h.extra.number as number}` : ""}
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
      {footer ? (
        <div className="border-t border-slate-100 px-3 py-2 text-[10px] text-slate-500 dark:text-slate-400 dark:border-slate-800">
          <kbd className="rounded border border-slate-300 px-1 dark:border-slate-700">↵</kbd> open top result ·{" "}
          <kbd className="rounded border border-slate-300 px-1 dark:border-slate-700">esc</kbd> close
        </div>
      ) : null}
    </>
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
export function highlightedHtml(formatted: string | undefined, raw: string, maxChars?: number): string {
  const source = formatted ?? raw;
  const limited = typeof maxChars === "number" ? source.slice(0, maxChars) : source;
  const escaped = escapeHtml(limited);
  // `<mark>` is a safe inert element with no event handlers, so un-escaping every
  // (Meili-injected or attacker-written) `&lt;mark&gt;` is not exploitable.
  return escaped.replace(/&lt;mark&gt;/g, "<mark>").replace(/&lt;\/mark&gt;/g, "</mark>");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
