"use client";

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@church/shared";

/**
 * Generic attachment widget. Renders the list, lets the user upload (button +
 * drop target), and per-item × delete. Wire it to a parent by passing its
 * proxy base URL — e.g. /api/notes/{noteId}/attachments. The parent's own
 * route handler does the auth check; this component is purely transport.
 *
 *   <AttachmentList baseUrl={`/api/notes/${noteId}/attachments`} canEdit />
 */
export function AttachmentList({
  baseUrl,
  canEdit = true,
  layout = "grid",
}: {
  baseUrl: string;
  canEdit?: boolean;
  layout?: "grid" | "row";
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setError(null);
    const r = await fetch(baseUrl, { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) {
      setError(`Couldn't load attachments (${r.status})`);
      return;
    }
    setItems((await r.json()) as Attachment[]);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(baseUrl, { method: "POST", body: fd, credentials: "same-origin" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `Upload failed (${r.status})`);
        return;
      }
      await refresh();
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function destroy(aid: string) {
    if (!confirm("Remove this attachment?")) return;
    const r = await fetch(`${baseUrl}/${aid}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) setItems((prev) => prev.filter((a) => a.id !== aid));
    else setError(`Delete failed (${r.status})`);
  }

  function onDrop(e: React.DragEvent) {
    if (!canEdit) return;
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  }

  const grid = layout === "grid"
    ? "grid grid-cols-3 gap-1.5"
    : "flex flex-wrap gap-2";

  return (
    <div onDrop={onDrop} onDragOver={(e) => canEdit && e.preventDefault()}>
      {items.length > 0 ? (
        <ul className={grid}>
          {items.map((a) => (
            <li key={a.id} className="group relative">
              {a.contentType.startsWith("image/") ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`${baseUrl}/${a.id}`}
                  alt={a.filename}
                  title={a.filename}
                  className={
                    layout === "grid"
                      ? "aspect-square h-full w-full rounded border border-slate-200 object-cover dark:border-slate-700"
                      : "h-20 w-20 rounded border border-slate-200 object-cover dark:border-slate-700"
                  }
                  loading="lazy"
                />
              ) : (
                <a
                  href={`${baseUrl}/${a.id}`}
                  className={
                    layout === "grid"
                      ? "flex aspect-square w-full flex-col items-center justify-center rounded border border-slate-200 bg-slate-50 p-1 text-center text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      : "flex items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  }
                  title={a.filename}
                >
                  <span>📄</span>
                  <span className={layout === "grid" ? "line-clamp-2 break-all" : "truncate max-w-[16rem]"}>
                    {a.filename}
                  </span>
                </a>
              )}
              {canEdit ? (
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => destroy(a.id)}
                  className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-xs text-white group-hover:flex hover:bg-slate-900"
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-rose-600">{error}</p>
      ) : null}
      {canEdit ? (
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
          <span>📎 {busy ? "Uploading…" : "Attach file"}</span>
          <span className="text-slate-400 dark:text-slate-500">(or drop here)</span>
        </label>
      ) : null}
    </div>
  );
}
