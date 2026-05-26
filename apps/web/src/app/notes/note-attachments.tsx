"use client";

import { useEffect, useRef, useState } from "react";
import type { Attachment } from "@church/shared";

export function NoteAttachments({ noteId }: { noteId: string }) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    setError(null);
    const r = await fetch(`/api/notes/${noteId}/attachments`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok) {
      setError(`Couldn't load attachments (${r.status})`);
      return;
    }
    setItems((await r.json()) as Attachment[]);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId]);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/notes/${noteId}/attachments`, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
      });
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
    const r = await fetch(`/api/notes/${noteId}/attachments/${aid}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) setItems((prev) => prev.filter((a) => a.id !== aid));
    else setError(`Delete failed (${r.status})`);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  }

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
      className="mt-2 border-t border-slate-200 pt-2 dark:border-slate-800"
    >
      {items.length > 0 ? (
        <ul className="mb-2 grid grid-cols-3 gap-1.5">
          {items.map((a) => (
            <li key={a.id} className="group relative">
              {a.contentType.startsWith("image/") ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={`/api/notes/${noteId}/attachments/${a.id}`}
                  alt={a.filename}
                  title={a.filename}
                  className="aspect-square h-full w-full rounded border border-slate-200 object-cover dark:border-slate-700"
                  loading="lazy"
                />
              ) : (
                <a
                  href={`/api/notes/${noteId}/attachments/${a.id}`}
                  className="flex aspect-square w-full flex-col items-center justify-center rounded border border-slate-200 bg-slate-50 p-1 text-center text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  title={a.filename}
                >
                  <span className="text-base">📄</span>
                  <span className="line-clamp-2 break-all">{a.filename}</span>
                </a>
              )}
              <button
                type="button"
                aria-label="Remove attachment"
                onClick={() => destroy(a.id)}
                className="absolute right-0.5 top-0.5 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-xs text-white group-hover:flex hover:bg-slate-900"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="mb-2 text-xs text-rose-600">{error}</p>
      ) : null}
      <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
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
    </div>
  );
}
