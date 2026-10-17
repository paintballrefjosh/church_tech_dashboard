"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { buildDiff, collapseUnchanged, type DiffRow, type DiffSegment } from "@/lib/wiki-diff";

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

/** The live page, offered next to the saved revisions as something to compare with. */
const CURRENT = "current";

interface Version {
  id: string;
  title: string;
  body: string;
  label: string;
}

/**
 * Page history: the saved revisions on the left, and on the right what changed between two versions. Choosing a revision
 * shows what that edit changed (it against the one before); the two menus compare any pair, including the page as it is
 * now. Changed words are marked inside a changed line, long unchanged stretches are folded, and "This version" shows the
 * text as it was. Restoring writes the chosen revision back as a new one (nothing is lost).
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
  const [selectedId, setSelectedId] = useState<string>(revisions[0]?.id ?? CURRENT);
  const [fromOverride, setFromOverride] = useState<string | null>(null);
  const [toOverride, setToOverride] = useState<string | null>(null);
  const [tab, setTab] = useState<"changes" | "text">("changes");
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function editorLabel(r: Revision): string {
    return r.editorName ?? r.editorEmail ?? "Unknown user";
  }
  const when = (iso: string) => new Date(iso).toLocaleString();

  const versions = useMemo<Version[]>(
    () => [
      { id: CURRENT, title: currentTitle, body: currentBody, label: "The page now" },
      ...revisions.map((r) => ({ id: r.id, title: r.title, body: r.body, label: `${when(r.createdAt)} by ${editorLabel(r)}` })),
    ],
    [revisions, currentBody, currentTitle],
  );
  const byId = useMemo(() => new Map(versions.map((v) => [v.id, v])), [versions]);

  // Choosing a revision compares it with the one before; the menus override either end.
  const index = revisions.findIndex((r) => r.id === selectedId);
  const previousId = index >= 0 ? (revisions[index + 1]?.id ?? null) : null;
  const toId = toOverride ?? selectedId;
  const fromId = fromOverride === "none" ? null : (fromOverride ?? previousId);
  const to = byId.get(toId) ?? versions[0]!;
  const from = fromId ? (byId.get(fromId) ?? null) : null;

  const diff = useMemo(() => buildDiff(from?.body ?? "", to.body), [from, to]);
  const items = useMemo(() => collapseUnchanged(diff.rows, 3), [diff]);
  const titleChanged = from !== null && from.title !== to.title;
  const unchanged = diff.added === 0 && diff.removed === 0 && !titleChanged;

  function choose(id: string) {
    setSelectedId(id);
    setFromOverride(null);
    setToOverride(null);
    setExpanded(new Set());
  }

  async function restore() {
    if (!canEdit || toId === CURRENT) return;
    const rev = revisions.find((r) => r.id === toId);
    if (!rev) return;
    if (!confirm(`Restore the version from ${when(rev.createdAt)}? The page as it is now is kept in the history.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/v1/wiki/${pageId}/revisions/${rev.id}/revert`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        setError(`Restore failed (${r.status})`);
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

  const select =
    "min-w-0 max-w-full rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950";

  return (
    <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
      <nav aria-label="Saved versions" className="rounded-md border border-slate-300 dark:border-slate-800">
        <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800" data-testid="revision-list">
          {revisions.map((r) => {
            const sel = r.id === selectedId;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => choose(r.id)}
                  aria-current={sel ? "true" : undefined}
                  data-testid="revision-item"
                  className={`block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-900 ${
                    sel ? "bg-brand-50 dark:bg-brand-900/20" : ""
                  }`}
                >
                  <div className="text-xs text-slate-500">
                    {when(r.createdAt)} &middot; {editorLabel(r)}
                  </div>
                  <div className="truncate text-sm font-medium">{r.title}</div>
                  {r.summary ? <div className="truncate text-xs text-slate-500">{r.summary}</div> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="min-w-0 rounded-md border border-slate-300 dark:border-slate-800" aria-label="What changed">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-300 px-3 py-2 text-sm dark:border-slate-800">
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            From
            <select
              value={fromId ?? "none"}
              onChange={(e) => setFromOverride(e.target.value)}
              className={select}
              data-testid="diff-from"
            >
              <option value="none">(nothing: the start)</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            to
            <select value={toId} onChange={(e) => setToOverride(e.target.value)} className={select} data-testid="diff-to">
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
          <span className="text-xs text-slate-500" data-testid="diff-stats">
            {unchanged ? "no difference" : `${diff.added} added, ${diff.removed} removed`}
          </span>
          {canEdit && toId !== CURRENT ? (
            <button
              type="button"
              onClick={() => void restore()}
              disabled={busy}
              data-testid="restore"
              className="ml-auto rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
            >
              Restore this version
            </button>
          ) : null}
        </header>

        <div role="tablist" aria-label="View" className="flex gap-1 border-b border-slate-200 px-3 pt-2 text-xs dark:border-slate-800">
          {(["changes", "text"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-t-md border-x border-t px-3 py-1.5 ${
                tab === t
                  ? "border-slate-300 bg-white font-medium dark:border-slate-700 dark:bg-slate-950"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              {t === "changes" ? "Changes" : "This version"}
            </button>
          ))}
        </div>

        {error ? (
          <p role="alert" className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            {error}
          </p>
        ) : null}

        {tab === "changes" ? (
          <div>
            {titleChanged ? (
              <p className="border-b border-slate-200 px-3 py-2 text-xs dark:border-slate-800" data-testid="diff-title">
                <span className="font-medium">Title:</span>{" "}
                <span className="rounded bg-rose-100 px-1 text-rose-900 line-through dark:bg-rose-900/40 dark:text-rose-100">{from?.title}</span>{" "}
                <span aria-hidden>&rarr;</span>
                <span className="sr-only">changed to</span>{" "}
                <span className="rounded bg-emerald-100 px-1 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100">{to.title}</span>
              </p>
            ) : null}
            {unchanged ? (
              <p className="p-4 text-sm text-slate-500 dark:text-slate-400">These two versions are the same.</p>
            ) : (
              <div className="overflow-x-auto p-1 font-mono text-xs" data-testid="diff-body">
                {items.map((item) =>
                  item.type === "row" ? (
                    <Row key={`${item.row.kind}-${item.row.oldNo ?? "x"}-${item.row.newNo ?? "x"}`} row={item.row} />
                  ) : expanded.has(item.id) ? (
                    item.rows.map((row) => <Row key={`${row.kind}-${row.oldNo}-${row.newNo}`} row={row} />)
                  ) : (
                    <button
                      key={`gap-${item.id}`}
                      type="button"
                      onClick={() => setExpanded((s) => new Set(s).add(item.id))}
                      className="block w-full border-y border-dashed border-slate-300 bg-slate-50 px-2 py-1 text-left text-slate-500 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
                    >
                      Show {item.rows.length} unchanged lines
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ) : (
          <div>
            <p className="border-b border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
              {to.title} &middot; {to.label}
            </p>
            <pre className="overflow-x-auto whitespace-pre-wrap p-3 font-mono text-xs" data-testid="version-text">
              {to.body || "(empty)"}
            </pre>
          </div>
        )}
      </section>
    </div>
  );
}

/** One line of the comparison. The sign and a hidden word say added or removed, so colour is not the only cue. */
function Row({ row }: { row: DiffRow }) {
  const tone =
    row.kind === "add"
      ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100"
      : row.kind === "remove"
        ? "bg-rose-50 text-rose-950 dark:bg-rose-950/40 dark:text-rose-100"
        : "text-slate-600 dark:text-slate-400";
  const mark = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
  const segments: DiffSegment[] = row.kind === "same" ? [{ text: row.text, changed: false }] : row.segments;
  const hit =
    row.kind === "add"
      ? "bg-emerald-200 dark:bg-emerald-800/70"
      : "bg-rose-200 line-through decoration-rose-500 dark:bg-rose-800/70";
  return (
    <div className={`flex gap-2 px-1 ${tone}`} data-diff={row.kind}>
      <span className="w-8 shrink-0 select-none text-right text-slate-400" aria-hidden>
        {row.oldNo ?? ""}
      </span>
      <span className="w-8 shrink-0 select-none text-right text-slate-400" aria-hidden>
        {row.newNo ?? ""}
      </span>
      <span className="w-3 shrink-0 select-none font-bold" aria-hidden>
        {mark}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        {row.kind !== "same" ? <span className="sr-only">{row.kind === "add" ? "Added: " : "Removed: "}</span> : null}
        {segments.map((s, i) =>
          s.changed && row.kind !== "same" && segments.length > 1 ? (
            <span key={i} className={`rounded-sm ${hit}`}>
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {row.text === "" ? " " : null}
      </span>
    </div>
  );
}
