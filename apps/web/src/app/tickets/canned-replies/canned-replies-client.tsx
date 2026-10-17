"use client";

import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { CANNED_REPLY_BODY_MAX, CANNED_REPLY_TITLE_MAX, type CannedReply } from "@church/shared";

const API = "/api/v1/tickets/canned-replies";
const field =
  "w-full rounded-md border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950";

async function messageOf(res: Response, fallback: string): Promise<string> {
  const b = (await res.json().catch(() => ({}))) as { message?: unknown };
  return typeof b.message === "string" ? b.message : `${fallback} (${res.status})`;
}

export function CannedRepliesClient({ initial, canWrite }: { initial: CannedReply[]; canWrite: boolean }) {
  const [replies, setReplies] = useState(initial);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function start(r: CannedReply | null) {
    setErr(null);
    setEditing(r ? r.id : "new");
    setTitle(r?.title ?? "");
    setBody(r?.body ?? "");
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const creating = editing === "new";
      const res = await fetch(creating ? API : `${API}/${editing}`, {
        method: creating ? "POST" : "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) {
        setErr(await messageOf(res, "Could not save"));
        return;
      }
      const saved = (await res.json()) as CannedReply;
      setReplies((prev) => (creating ? [...prev, saved] : prev.map((r) => (r.id === saved.id ? saved : r))).sort((a, b) => a.title.localeCompare(b.title)));
      setEditing(null);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: CannedReply) {
    if (!confirm(`Delete the saved reply "${r.title}"?`)) return;
    setErr(null);
    const res = await fetch(`${API}/${r.id}`, { method: "DELETE", credentials: "same-origin" });
    if (res.ok) setReplies((prev) => prev.filter((x) => x.id !== r.id));
    else setErr(await messageOf(res, "Could not delete"));
  }

  return (
    <div className="mt-6 space-y-5">
      {canWrite && editing === null ? (
        <button
          type="button"
          onClick={() => start(null)}
          data-testid="canned-new"
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
        >
          <Plus className="h-4 w-4" aria-hidden /> New saved reply
        </button>
      ) : null}
      {!canWrite ? (
        <p className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">
          You can use these in any ticket. Changing them takes ticket admin access.
        </p>
      ) : null}

      {editing !== null ? (
        <form onSubmit={save} className="space-y-3 rounded-md border border-slate-300 p-4 dark:border-slate-800" data-testid="canned-form">
          <label className="block text-xs text-slate-500">
            Title (what you will look for in the list)
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              maxLength={CANNED_REPLY_TITLE_MAX}
              className={`mt-1 ${field}`}
              data-testid="canned-title"
            />
          </label>
          <label className="block text-xs text-slate-500">
            Reply
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={7}
              maxLength={CANNED_REPLY_BODY_MAX}
              className={`mt-1 ${field}`}
              data-testid="canned-body"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              disabled={busy || !title.trim() || !body.trim()}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {err ? (
        <p role="alert" className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      {replies.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          No saved replies yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800" data-testid="canned-list">
          {replies.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{r.title}</div>
                <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-slate-600 dark:text-slate-400">{r.body}</p>
              </div>
              {canWrite ? (
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => start(r)} aria-label={`Edit ${r.title}`} className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={() => void remove(r)} aria-label={`Delete ${r.title}`} className="text-rose-600 hover:text-rose-700">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
