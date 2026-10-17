"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WikiTreeNode } from "@church/shared";

export interface PickedWikiPage {
  id: string;
  title: string;
}

/**
 * "Link to a wiki page": a small search-as-you-type dialog over the pages the person can read (the same list the
 * sidebar uses). The editor inserts a normal Markdown link to `/wiki/<id>`, which is what the page's "Linked from"
 * list is built from, so there is nothing else to keep in step.
 */
export function WikiPagePicker({ onPick, onClose }: { onPick: (page: PickedWikiPage) => void; onClose: () => void }) {
  const [pages, setPages] = useState<PickedWikiPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/v1/wiki/tree", { credentials: "same-origin", cache: "no-store" });
        if (!r.ok) throw new Error(String(r.status));
        const nodes = (await r.json()) as WikiTreeNode[];
        if (cancelled) return;
        setPages(
          nodes
            .filter((n): n is Extract<WikiTreeNode, { kind: "page" }> => n.kind === "page")
            .map((n) => ({ id: n.id, title: n.title })),
        );
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pages ?? []).filter((p) => !q || p.title.toLowerCase().includes(q)).slice(0, 50);
  }, [pages, query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab") {
      // Keep Tab inside the dialog: it is modal.
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("input, button") ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first && last) {
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((h) => (shown.length ? (h + 1) % shown.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((h) => (shown.length ? (h - 1 + shown.length) % shown.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = shown[hover];
      if (p) onPick(p);
    }
  }

  // In a portal: the editor sits inside a box that would otherwise make "fixed" mean "inside the editor".
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 px-4 pt-[15vh]" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-page-picker-title"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-lg border border-slate-300 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 id="wiki-page-picker-title" className="text-sm font-semibold">
          Link to a wiki page
        </h2>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHover(0);
          }}
          placeholder="Search pages by title"
          aria-label="Search pages by title"
          className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
        <ul role="listbox" aria-label="Pages" className="mt-2 max-h-64 overflow-y-auto rounded-md border border-slate-200 dark:border-slate-800">
          {pages === null && !failed ? <li className="px-3 py-2 text-sm text-slate-500">Loading...</li> : null}
          {failed ? <li className="px-3 py-2 text-sm text-rose-600">Could not load the pages.</li> : null}
          {pages !== null && shown.length === 0 ? <li className="px-3 py-2 text-sm text-slate-500">No page matches.</li> : null}
          {shown.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === hover}>
              <button
                type="button"
                onClick={() => onPick(p)}
                onMouseEnter={() => setHover(i)}
                className={`block w-full truncate px-3 py-2 text-left text-sm ${
                  i === hover ? "bg-brand-50 dark:bg-brand-900/20" : "hover:bg-slate-50 dark:hover:bg-slate-800"
                }`}
              >
                {p.title}
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
