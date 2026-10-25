"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import { WikiPagePicker } from "./wiki-page-picker";

type Title = { state: "loading" } | { state: "ok"; title: string } | { state: "hidden" };

/**
 * The title of a linked wiki page, read through the wiki's own route: someone who may see the monitor but not the page
 * gets "hidden", never the title.
 */
function usePageTitle(pageId: string | null): Title | null {
  const [t, setT] = useState<Title | null>(pageId ? { state: "loading" } : null);
  useEffect(() => {
    if (!pageId) {
      setT(null);
      return;
    }
    let cancelled = false;
    setT({ state: "loading" });
    fetch(`/api/v1/wiki/${encodeURIComponent(pageId)}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) return setT({ state: "hidden" });
        const body = (await r.json()) as { page?: { title?: string } };
        setT(body.page?.title ? { state: "ok", title: body.page.title } : { state: "hidden" });
      })
      .catch(() => !cancelled && setT({ state: "hidden" }));
    return () => {
      cancelled = true;
    };
  }, [pageId]);
  return t;
}

/** "What to do when this fails": shown on a monitor's or host's page. Renders nothing when no runbook is linked. */
export function RunbookCard({ pageId }: { pageId: string | null | undefined }) {
  const t = usePageTitle(pageId ?? null);
  if (!pageId || !t) return null;
  return (
    <div className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-800">
      <p className="flex items-center gap-2 font-medium">
        <BookOpen className="h-4 w-4" aria-hidden /> Runbook
      </p>
      {t.state === "ok" ? (
        <Link href={`/wiki/${pageId}`} className="mt-1 inline-block text-brand-600 hover:underline dark:text-brand-400">
          {t.title}
        </Link>
      ) : t.state === "hidden" ? (
        <p className="mt-1 text-slate-500 dark:text-slate-400">A runbook is linked, but you cannot open that wiki page.</p>
      ) : (
        <p className="mt-1 text-slate-500 dark:text-slate-400">Loading…</p>
      )}
    </div>
  );
}

/** Choose (or remove) the runbook in an edit form. `value` is a wiki page id or null. */
export function RunbookField({ value, onChange }: { value: string | null; onChange: (pageId: string | null) => void }) {
  const t = usePageTitle(value);
  const [picking, setPicking] = useState(false);
  return (
    <fieldset className="space-y-2 rounded-md border border-slate-300 p-3 dark:border-slate-700">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Runbook</legend>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        A wiki page with what to do when this fails. It is shown on this page, to the people who may read that wiki page.
      </p>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {value ? (
          <span className="font-medium">
            {t?.state === "ok" ? t.title : t?.state === "hidden" ? "A page you cannot open" : "Loading…"}
          </span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">None</span>
        )}
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700"
        >
          {value ? "Change" : "Choose a wiki page"}
        </button>
        {value ? (
          <button type="button" onClick={() => onChange(null)} className="rounded-md border border-slate-300 px-2 py-1 dark:border-slate-700">
            Remove
          </button>
        ) : null}
      </div>
      {picking ? (
        <WikiPagePicker
          onPick={(p) => {
            onChange(p.id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      ) : null}
    </fieldset>
  );
}
