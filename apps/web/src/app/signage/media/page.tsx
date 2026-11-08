"use client";

import { useCallback, useId, useRef, useState } from "react";
import { Clapperboard, Trash2, Upload } from "lucide-react";
import { SIGNAGE_LIMITS, type SignageMedia } from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, btnCls, bytes, dangerCls, inputCls, primaryCls, seconds, useSignagePerms } from "../signage-ui";

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
      // XMLHttpRequest, not fetch: it is the one that reports upload progress.
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/signage/media");
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
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {shown.map((m) => (
            <li key={m.id} className="flex flex-col overflow-hidden rounded-md border border-slate-300 dark:border-slate-800">
              <div className="relative aspect-video bg-slate-900">
                {m.hasThumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/signage/media/${m.id}/thumb`} alt="" className="h-full w-full object-cover" loading="lazy" />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-300">{STATUS_TEXT[m.status]}</div>
                )}
                {m.kind === "video" && m.durationS ? <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-xs text-white">{seconds(m.durationS)}</span> : null}
              </div>
              <div className="flex flex-1 flex-col gap-1 p-2 text-sm">
                <span className="truncate font-medium text-slate-900 dark:text-slate-100" title={m.name}>
                  {m.name}
                </span>
                <span className={`text-xs ${m.status === "failed" || m.status === "missing" ? "text-rose-700 dark:text-rose-300" : "text-slate-500 dark:text-slate-400"}`}>
                  {m.status === "ready" ? [m.kind === "video" ? "Video" : "Picture", m.width && m.height ? `${m.width}x${m.height}` : null, bytes(m.sizeBytes)].filter(Boolean).join(" · ") : STATUS_TEXT[m.status]}
                </span>
                {m.error ? <span className="text-xs text-rose-700 dark:text-rose-300">{m.error}</span> : null}
                <span className="text-xs text-slate-500 dark:text-slate-400">{m.usedBy.length ? `In ${m.usedBy.map((u) => u.playlistName).join(", ")}` : "Not in a playlist"}</span>
                {perms.write ? (
                  <div className="mt-auto flex gap-1 pt-1">
                    <button type="button" className={btnCls} onClick={() => setEditing(m)} aria-label={`Rename ${m.name}`}>
                      Rename
                    </button>
                    <button type="button" className={dangerCls} onClick={() => void remove(m)} aria-label={`Delete ${m.name}`}>
                      <Trash2 className="h-4 w-4" aria-hidden />
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
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
