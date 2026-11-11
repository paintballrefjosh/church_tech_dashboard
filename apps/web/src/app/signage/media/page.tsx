"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Clapperboard, Pencil, Trash2, Upload } from "lucide-react";
import { SIGNAGE_LIMITS, type SignageMedia } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { aspectOf, justifiedRows } from "@/lib/justified-rows";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, btnCls, bytes, inputCls, primaryCls, seconds, useSignagePerms } from "../signage-ui";

interface Upload {
  key: number;
  name: string;
  done: number;
  total: number;
  error: string | null;
}

const STATUS_TEXT: Record<SignageMedia["status"], string> = {
  uploaded: "Waiting to be converted",
  processing: "Converting",
  ready: "Ready",
  failed: "Could not be converted",
  missing: "File missing: upload it again",
};

/** Pictures and videos for the screens. Each upload is converted once (1080p H.264, no sound; pictures resized). */
export default function SignageMediaPage() {
  const perms = useSignagePerms();
  const [rows, setRows] = useState<SignageMedia[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [editing, setEditing] = useState<SignageMedia | null>(null);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const filterId = useId();

  const load = useCallback(async () => {
    const r = await fetch("/api/signage/media", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setRows((await r.json()) as SignageMedia[]);
  }, []);
  const busy = rows?.some((m) => m.status === "uploaded" || m.status === "processing") || uploads.some((u) => !u.error && u.done < u.total);
  usePoll(load, busy ? 4_000 : 30_000);

  function upload(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      const key = Date.now() + Math.random();
      if (f.size > SIGNAGE_LIMITS.maxUploadBytes) {
        setUploads((u) => [...u, { key, name: f.name, done: 0, total: f.size, error: `Larger than ${bytes(SIGNAGE_LIMITS.maxUploadBytes)}` }]);
        continue;
      }
      setUploads((u) => [...u, { key, name: f.name, done: 0, total: f.size, error: null }]);
      const form = new FormData();
      form.append("file", f, f.name);
      // XMLHttpRequest, not fetch: it is the one that reports upload progress. Straight to the API (Caddy routes /api/v1/*
      // there), never through the web's /api/signage proxy: Next's middleware keeps only the first 10 MB of a request
      // body, so every video over that arrived cut short and the API aborted it.
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/v1/signage/media");
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, done: e.loaded, total: e.total || x.total } : x)));
      xhr.onload = () => {
        let message: string | null = null;
        if (xhr.status >= 300) {
          try {
            const b = JSON.parse(xhr.responseText) as { message?: unknown };
            message = typeof b.message === "string" ? b.message : `Upload failed (${xhr.status})`;
          } catch {
            message = `Upload failed (${xhr.status})`;
          }
        }
        setUploads((u) => (message ? u.map((x) => (x.key === key ? { ...x, error: message } : x)) : u.filter((x) => x.key !== key)));
        void load();
      };
      xhr.onerror = () => setUploads((u) => u.map((x) => (x.key === key ? { ...x, error: "The upload stopped (network)" } : x)));
      xhr.send(form);
    }
  }

  async function remove(m: SignageMedia) {
    if (!window.confirm(`Delete ${m.name}?`)) return;
    setErr(null);
    try {
      await sendJson(`/api/signage/media/${m.id}`, "DELETE");
      void load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (forbidden) return <Forbidden />;
  const shown = (rows ?? []).filter((m) => !filter || m.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={Clapperboard}>Media</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Pictures (JPEG, PNG, WebP, HEIC) and videos (MP4, MOV, most others) up to {bytes(SIGNAGE_LIMITS.maxUploadBytes)}. Each is converted once to suit a 1080p TV; sound is removed.
          </p>
        </div>
        {perms.write ? (
          <button type="button" className={primaryCls} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" aria-hidden /> Upload
          </button>
        ) : null}
      </div>

      {perms.write ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
          }}
          className={`rounded-md border-2 border-dashed p-4 text-center text-sm ${dragging ? "border-brand-500 bg-brand-50 text-slate-700 dark:bg-brand-950 dark:text-slate-200" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-300"}`}
        >
          Drop files here, or{" "}
          <button type="button" className="text-brand-600 underline dark:text-brand-400" onClick={() => fileRef.current?.click()}>
            choose them
          </button>
          .
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,video/*"
            className="sr-only"
            aria-label="Choose files to upload"
            onChange={(e) => {
              if (e.target.files?.length) upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : null}

      {uploads.length ? (
        <ul className="space-y-2" aria-live="polite">
          {uploads.map((u) => (
            <li key={u.key} className="text-sm">
              <div className="flex justify-between gap-2">
                <span className="truncate text-slate-800 dark:text-slate-100">{u.name}</span>
                <span className={u.error ? "text-rose-700 dark:text-rose-300" : "text-slate-500 dark:text-slate-400"}>{u.error ?? `${Math.round((u.done / Math.max(1, u.total)) * 100)}%`}</span>
              </div>
              {!u.error ? (
                <progress className="h-1.5 w-full" value={u.done} max={u.total} aria-label={`Uploading ${u.name}`} />
              ) : (
                <button type="button" className="text-xs text-brand-600 underline dark:text-brand-400" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>
                  Dismiss
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      <ErrorLine text={err} />

      {rows && rows.length > 8 ? (
        <div className="max-w-xs">
          <Label htmlFor={filterId}>Find</Label>
          <input id={filterId} className={inputCls} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name" />
        </div>
      ) : null}

      {rows === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">Nothing uploaded yet.</p>
      ) : (
        <MediaRows items={shown} write={perms.write} onRename={setEditing} onDelete={(m) => void remove(m)} />
      )}

      {editing ? (
        <RenameModal
          m={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

const GAP = 6;

/** The page's width, measured (0 until the first layout). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/**
 * Media as justified rows (like a photo library): each picture or video keeps its own shape and every row fills the width
 * (`justifiedRows`). The name and details sit in a strip over the picture's foot, shown on hover or keyboard focus, and
 * always on touch screens, which have no hover; a problem (conversion failed, file missing) is always shown.
 */
function MediaRows({ items, write, onRename, onDelete }: { items: SignageMedia[]; write: boolean; onRename: (m: SignageMedia) => void; onDelete: (m: SignageMedia) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const target = width && width < 640 ? 130 : 180;
  const rows = useMemo(() => justifiedRows(items.map((m) => aspectOf(m.width, m.height)), { containerWidth: width, targetHeight: target, gap: GAP }), [items, width, target]);
  return (
    <div ref={ref} className="w-full">
      {items.length === 0 ? <p className="text-sm text-slate-500 dark:text-slate-400">Nothing matches.</p> : null}
      {/* One flat list (a screen reader hears "list, N items"); each row ends with a zero-height break so rows are exactly
          the ones justifiedRows chose, whatever the rounding. Rows are spaced by each tile's bottom margin. */}
      <ul className="flex flex-wrap" style={{ columnGap: GAP }} aria-label="Media">
        {rows.map((row, r) => [
          ...row.map((b) => {
            const m = items[b.index]!;
            return <MediaTile key={m.id} m={m} width={b.width} height={b.height} write={write} onRename={onRename} onDelete={onDelete} />;
          }),
          r < rows.length - 1 ? <li key={`break-${r}`} aria-hidden="true" className="h-0 basis-full" /> : null,
        ])}
      </ul>
    </div>
  );
}

const reveal = "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100";

function MediaTile({ m, width, height, write, onRename, onDelete }: { m: SignageMedia; width: number; height: number; write: boolean; onRename: (m: SignageMedia) => void; onDelete: (m: SignageMedia) => void }) {
  const problem = m.status === "failed" || m.status === "missing";
  const kindDims = [m.kind === "video" ? "Video" : "Picture", m.width && m.height ? `${m.width}x${m.height}` : null].filter(Boolean).join(" ");
  const used = m.usedBy.length ? `In ${m.usedBy.map((u) => u.playlistName).join(", ")}` : "Not in a playlist";
  // Two short lines over the picture (a narrow portrait tile is mostly caption otherwise); the size goes in the tooltip.
  const details = m.status === "ready" ? `${kindDims} · ${used}` : STATUS_TEXT[m.status];
  const tooltip = [m.name, m.status === "ready" ? `${kindDims}, ${bytes(m.sizeBytes)}` : STATUS_TEXT[m.status], used].join("\n");
  return (
    <li
      tabIndex={write ? undefined : 0}
      aria-label={write ? undefined : tooltip.replaceAll("\n", ". ")}
      className="group relative shrink-0 overflow-hidden rounded-md bg-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      style={{ width, height, marginBottom: GAP }}
      title={tooltip}
    >
      {m.hasThumb ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/signage/media/${m.id}/thumb`} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center p-2 text-center text-xs text-slate-200">{STATUS_TEXT[m.status]}</div>
      )}
      {m.kind === "video" && m.durationS ? <span className="absolute left-1 top-1 rounded bg-black/75 px-1 text-xs text-white">{seconds(m.durationS)}</span> : null}
      {problem ? <span className="absolute left-1 top-1 rounded bg-rose-700 px-1 text-xs text-white">{m.status === "missing" ? "File missing" : "Failed"}</span> : null}
      <div className={`absolute inset-x-0 bottom-0 bg-black/75 px-2 py-1 text-xs text-white ${problem ? "" : reveal}`}>
        <p className="truncate font-medium">{m.name}</p>
        <p className="truncate text-slate-200">{details}</p>
        {m.error ? <p className="line-clamp-2 text-rose-200">{m.error}</p> : null}
      </div>
      {write ? (
        <div className={`absolute right-1 top-1 flex gap-1 ${reveal}`}>
          <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded bg-black/75 text-white hover:bg-black" onClick={() => onRename(m)} aria-label={`Rename ${m.name}`}>
            <Pencil className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button type="button" className="inline-flex h-7 w-7 items-center justify-center rounded bg-black/75 text-white hover:bg-rose-700" onClick={() => onDelete(m)} aria-label={`Delete ${m.name}`}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
    </li>
  );
}

function RenameModal({ m, onClose, onSaved }: { m: SignageMedia; onClose: () => void; onSaved: () => void }) {
  const id = useId();
  const [name, setName] = useState(m.name);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await sendJson(`/api/signage/media/${m.id}`, "PATCH", { name: name.trim() });
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title="Rename" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={id}>Name</Label>
          <input id={id} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Uploaded as {m.originalName}.</p>
        <ErrorLine text={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryCls} disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
