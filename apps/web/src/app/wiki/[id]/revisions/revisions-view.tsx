"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { diffLines } from "diff";

interface Revision {
  id: string;
  title: string;
  body: string;
  editorUserId: string | null;
  editorName: string | null;
  editorEmail: string | null;
  summary: string | null;
  createdAt: string;
}

/**
 * Shows the revision list on the left, a unified-diff view on the right.
 * "Current" is a synthetic entry at the top; selecting any revision diffs
 * its body against the current page. Revert posts to the API and refreshes.
 */
export function RevisionsView({
  pageId,
  currentBody,
  currentTitle,
  canEdit,
  revisions,
}: {
  pageId: string;
  currentBody: string;
  currentTitle: string;
  canEdit: boolean;
  revisions: Revision[];
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(revisions[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = revisions.find((r) => r.id === selectedId) ?? revisions[0];

  function editorLabel(r: Revision): string {
    return r.editorName ?? r.editorEmail ?? "Unknown user";
  }

  // Line-level diff: current body vs selected revision. Using diff's
  // line-mode keeps the diff compact for prose where word-level would be
  // visually noisy.
  const parts = useMemo(() => {
    if (!selected) return [];
    return diffLines(selected.body, currentBody);
  }, [selected, currentBody]);

  async function revert() {
    if (!selected || !canEdit) return;
    if (
      !confirm(
        `Revert to revision from ${new Date(selected.createdAt).toLocaleString()}? Current contents will be saved as a new revision.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/wiki/${pageId}/revisions/${selected.id}/revert`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        setError(`Revert failed (${r.status})`);
        return;
      }
      router.push(`/wiki/${pageId}`);
    } finally {
      setBusy(false);
    }
  }

  if (revisions.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
        No revision history yet.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <aside className="rounded-md border border-slate-300 dark:border-slate-800">
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">
          {revisions.map((r) => {
            const sel = r.id === selectedId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  className={`block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900 ${
                    sel ? "bg-brand-50 dark:bg-brand-900/20" : ""
                  }`}
                >
                  <div className="text-xs text-slate-500">
                    {new Date(r.createdAt).toLocaleString()} &middot; {editorLabel(r)}
                  </div>
                  <div className="truncate text-sm font-medium">{r.title}</div>
                  {r.summary ? (
                    <div className="truncate text-xs text-slate-500">{r.summary}</div>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="rounded-md border border-slate-300 dark:border-slate-800">
        <header className="flex items-center gap-3 border-b border-slate-300 px-3 py-2 text-sm dark:border-slate-800">
          <span className="font-medium">{selected?.title ?? currentTitle}</span>
          <span className="text-xs text-slate-500">
            vs current ({currentBody.length} chars)
          </span>
          {canEdit && selected ? (
            <button
              type="button"
              onClick={revert}
              disabled={busy}
              className="ml-auto rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
            >
              Restore this revision
            </button>
          ) : null}
        </header>
        {error ? (
          <p className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        ) : null}
        <pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs">
          {parts.map((part, i) => {
            const cls = part.added
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100"
              : part.removed
                ? "bg-rose-100 text-rose-900 line-through dark:bg-rose-900/40 dark:text-rose-100"
                : "text-slate-600 dark:text-slate-400";
            const prefix = part.added ? "+ " : part.removed ? "- " : "  ";
            return (
              <span key={i} className={`block ${cls}`}>
                {part.value
                  .split("\n")
                  .filter((_, idx, arr) => !(idx === arr.length - 1 && arr[idx] === ""))
                  .map((line, j) => (
                    <span key={j} className="block">
                      {prefix}
                      {line}
                    </span>
                  ))}
              </span>
            );
          })}
        </pre>
      </section>
    </div>
  );
}
