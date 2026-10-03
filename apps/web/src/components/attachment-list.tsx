"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, File as FileIcon, X, Upload, PlusSquare } from "lucide-react";
import type { Attachment } from "@church/shared";
import { Lightbox } from "@/components/lightbox";

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
  onChange,
  onInsert,
  onUploaded,
}: {
  baseUrl: string;
  canEdit?: boolean;
  layout?: "grid" | "row";
  /** Fired after a successful upload or delete so parents can refresh sibling state. */
  onChange?: (event: "upload" | "delete") => void;
  /**
   * When provided, each item gets an "insert" button that hands the attachment
   * back to the parent — used by the wiki editor to drop a markdown reference
   * into the body at the cursor.
   */
  onInsert?: (a: Attachment) => void;
  /** Like onInsert but fires automatically after a successful upload. */
  onUploaded?: (a: Attachment) => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const dragDepth = useRef(0);
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
      const created = (await r.json().catch(() => null)) as Attachment | null;
      await refresh();
      onChange?.("upload");
      if (created && onUploaded) onUploaded(created);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function destroy(aid: string) {
    if (!confirm("Remove this attachment?")) return;
    const r = await fetch(`${baseUrl}/${aid}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) {
      setItems((prev) => prev.filter((a) => a.id !== aid));
      onChange?.("delete");
    } else setError(`Delete failed (${r.status})`);
  }

  function onDrop(e: React.DragEvent) {
    if (!canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void upload(f);
  }
  function onDragEnter(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDragOver(true);
  }
  function onDragOver(e: React.DragEvent) {
    if (!canEdit || !e.dataTransfer.types?.includes("Files")) return;
    // Both dragenter AND dragover must preventDefault for drop to fire.
    e.preventDefault();
    e.stopPropagation();
  }
  function onDragLeave(e: React.DragEvent) {
    if (!canEdit) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  const grid = layout === "grid"
    ? "grid grid-cols-3 gap-1.5"
    : "flex flex-wrap gap-2";

  return (
    <div
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      className={`relative rounded-md ${dragOver ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-transparent" : ""}`}
    >
      {dragOver ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-brand-500/10 text-sm font-medium text-brand-700 dark:text-brand-200">
          <Upload className="mr-2 h-4 w-4" aria-hidden /> Drop to attach
        </div>
      ) : null}
      {items.length > 0 ? (
        <ul className={grid}>
          {items.map((a) => (
            <li key={a.id} className="group relative">
              {a.contentType.startsWith("image/") ? (
                <button
                  type="button"
                  onClick={() => setPreview(a)}
                  aria-label={`Open ${a.filename}`}
                  className="block w-full cursor-zoom-in"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`${baseUrl}/${a.id}`}
                    alt={a.filename}
                    title={a.filename}
                    className={
                      layout === "grid"
                        ? "aspect-square h-full w-full rounded border border-slate-300 object-cover dark:border-slate-700"
                        : "h-20 w-20 rounded border border-slate-300 object-cover dark:border-slate-700"
                    }
                    loading="lazy"
                    decoding="async"
                  />
                </button>
              ) : a.contentType.startsWith("video/") ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  src={`${baseUrl}/${a.id}`}
                  title={a.filename}
                  controls
                  preload="metadata"
                  className={
                    layout === "grid"
                      ? "aspect-square h-full w-full rounded border border-slate-300 bg-slate-950 object-cover dark:border-slate-700"
                      : "h-20 w-32 rounded border border-slate-300 bg-slate-950 object-cover dark:border-slate-700"
                  }
                />
              ) : (
                <a
                  href={`${baseUrl}/${a.id}`}
                  className={
                    layout === "grid"
                      ? "flex aspect-square w-full flex-col items-center justify-center rounded border border-slate-300 bg-slate-50 p-1 text-center text-[10px] text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      : "flex items-center gap-1.5 rounded border border-slate-300 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                  }
                  title={a.filename}
                >
                  <FileIcon className={layout === "grid" ? "h-5 w-5" : "h-4 w-4"} aria-hidden />
                  <span className={layout === "grid" ? "line-clamp-2 break-all" : "truncate max-w-[16rem]"}>
                    {a.filename}
                  </span>
                </a>
              )}
              <div className="absolute right-0.5 top-0.5 hidden gap-0.5 group-hover:flex">
                {onInsert ? (
                  <button
                    type="button"
                    aria-label={`Insert ${a.filename} into body`}
                    title="Insert into body"
                    onClick={() => onInsert(a)}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-xs text-white hover:bg-slate-900"
                  >
                    <PlusSquare className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
                {canEdit ? (
                  <button
                    type="button"
                    aria-label="Remove attachment"
                    onClick={() => destroy(a.id)}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900/70 text-xs text-white hover:bg-slate-900"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                ) : null}
              </div>
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
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          <span>{busy ? "Uploading…" : "Attach file"}</span>
          <span className="text-slate-400 dark:text-slate-500">(or drop here)</span>
        </label>
      ) : null}
      {preview ? (
        <Lightbox onClose={() => setPreview(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${baseUrl}/${preview.id}`}
            alt={preview.filename}
            className="max-h-[90vh] max-w-[95vw] rounded shadow-2xl"
          />
        </Lightbox>
      ) : null}
    </div>
  );
}
