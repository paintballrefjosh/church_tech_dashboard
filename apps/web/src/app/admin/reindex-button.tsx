"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";

interface ReindexResult {
  ok: boolean;
  counts?: {
    tickets: number;
    notes: number;
    wikiPages: number;
    monitors: number;
    monitoring: number;
  };
}

/**
 * Admin button to walk every searchable source table and re-push every doc
 * to Meilisearch. Recovery path when the index gets out of sync — Meili
 * wipe, mid-write crash, schema reshuffle. Runs synchronously and can take
 * a few seconds, so the button shows a busy state.
 */
export function ReindexButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReindexResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (
      !confirm(
        "Reindex Meilisearch from the database? This clears the current index and rebuilds it. Search will momentarily return fewer results.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/v1/search/reindex", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        setError(`Reindex failed (${r.status})`);
        return;
      }
      setResult((await r.json()) as ReindexResult);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium">Reindex Meilisearch</p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Walk the database and re-push every ticket, note, wiki page, and monitoring data point
            (monitors, infrastructure, Cisco) to the search index. UniFi devices/clients are kept
            current by the poller.
          </p>
        </div>
        <button
          type="button"
          onClick={go}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <RotateCcw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden />
          {busy ? "Reindexing…" : "Reindex now"}
        </button>
      </div>
      {result?.counts ? (
        <p className="mt-3 rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
          Reindexed {result.counts.tickets} tickets, {result.counts.notes} notes,{" "}
          {result.counts.wikiPages} wiki pages, and {result.counts.monitoring} monitoring data
          points ({result.counts.monitors} monitors + infrastructure/Cisco).
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/30 dark:text-rose-200">
          {error}
        </p>
      ) : null}
    </div>
  );
}
