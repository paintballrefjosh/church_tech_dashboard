"use client";

import { use, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowLeft, ArrowUp, ListVideo, Plus, Trash2 } from "lucide-react";
import type { SignageMedia, SignagePlaylist, SignagePlaylistItemInput } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { GoneNotice } from "@/components/gone-notice";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, btnCls, dangerCls, inputCls, primaryCls, seconds, useSignageJson, useSignagePerms } from "../../signage-ui";

interface Row extends SignagePlaylistItemInput {
  key: string;
  name: string;
  kind: string | null;
  hasThumb: boolean;
  mediaDurationS: number | null;
  status: string;
}

/** Edit one playlist: order, each item's time and dates, and add from the media library. Saved as a whole. */
export default function SignagePlaylistPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const perms = useSignagePerms();
  const ids = { name: useId(), desc: useId(), dur: useId() };
  const [pl, setPl] = useState<SignagePlaylist | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "forbidden">("loading");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [imageS, setImageS] = useState(8);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [picking, setPicking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function take(p: SignagePlaylist) {
    setPl(p);
    setName(p.name);
    setDescription(p.description);
    setImageS(p.defaultImageDurationS);
    setRows(
      p.items.map((it) => ({
        key: it.id,
        mediaId: it.mediaId,
        durationS: it.durationS,
        enabled: it.enabled,
        validFrom: it.validFrom,
        validUntil: it.validUntil,
        name: it.mediaName,
        kind: it.mediaKind,
        hasThumb: it.hasThumb,
        mediaDurationS: it.mediaDurationS,
        status: it.mediaStatus,
      })),
    );
    setDirty(false);
  }

  useEffect(() => {
    fetch(`/api/signage/playlists/${id}`, { credentials: "same-origin", cache: "no-store" }).then(async (r) => {
      if (r.status === 404) return setState("gone");
      if (r.status === 403) return setState("forbidden");
      if (r.ok) {
        take((await r.json()) as SignagePlaylist);
        setState("ok");
      }
    });
  }, [id]);

  const change = (fn: (r: Row[]) => Row[]) => {
    setRows(fn);
    setDirty(true);
    setSaved(null);
  };
  const move = (i: number, d: number) =>
    change((r) => {
      const n = [...r];
      const [x] = n.splice(i, 1);
      n.splice(i + d, 0, x!);
      return n;
    });

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        name: name.trim(),
        description,
        defaultImageDurationS: imageS,
        items: rows.map(({ mediaId, durationS, enabled, validFrom, validUntil }) => ({ mediaId, durationS, enabled, validFrom: validFrom || null, validUntil: validUntil || null })),
      };
      take(await sendJson<SignagePlaylist>(`/api/signage/playlists/${id}`, "PATCH", body));
      setSaved("Saved. Screens showing it get the change within a minute.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete the playlist ${pl?.name}? Schedule entries that are over and used it are deleted with it.`)) return;
    try {
      await sendJson(`/api/signage/playlists/${id}`, "DELETE");
      router.push("/signage/playlists");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (state === "forbidden") return <Forbidden />;
  if (state === "gone") return <GoneNotice what="playlist" backHref="/signage/playlists" backLabel="Playlists" />;
  if (!pl) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  const ro = !perms.write;
  const loop = rows.filter((r) => r.enabled).reduce((n, r) => n + (r.durationS ?? (r.kind === "video" ? (r.mediaDurationS ?? 0) : imageS)), 0);

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm">
        <Link href="/signage/playlists" className="inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Playlists
        </Link>
      </nav>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle icon={ListVideo}>{pl.name}</PageTitle>
        {!ro ? (
          <div className="flex gap-2">
            <button type="button" className={dangerCls} onClick={() => void remove()}>
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
            <button type="button" className={primaryCls} onClick={() => void save()} disabled={busy || !dirty || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-[2fr_3fr_1fr]">
        <div>
          <Label htmlFor={ids.name}>Name</Label>
          <input id={ids.name} className={inputCls} value={name} disabled={ro} onChange={(e) => (setName(e.target.value), setDirty(true))} maxLength={120} />
        </div>
        <div>
          <Label htmlFor={ids.desc}>Description</Label>
          <input id={ids.desc} className={inputCls} value={description} disabled={ro} onChange={(e) => (setDescription(e.target.value), setDirty(true))} maxLength={1000} />
        </div>
        <div>
          <Label htmlFor={ids.dur}>Picture time (s)</Label>
          <input id={ids.dur} type="number" min={1} max={3600} className={inputCls} value={imageS} disabled={ro} onChange={(e) => (setImageS(Number(e.target.value) || 8), setDirty(true))} />
        </div>
      </div>

      <p className="text-sm text-slate-600 dark:text-slate-300">
        {rows.length} item{rows.length === 1 ? "" : "s"}, one loop {seconds(loop)}. Videos play their own length unless given a time (a shorter time cuts it, a longer one loops it).
      </p>
      {pl.warnings.length ? (
        <ul className="space-y-1 text-sm text-amber-800 dark:text-amber-300">
          {pl.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
      <ErrorLine text={err} />
      {saved ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{saved}</p> : null}

      <ol className="space-y-2">
        {rows.map((r, i) => (
          <li key={r.key} className={`flex flex-wrap items-center gap-3 rounded-md border p-2 ${r.enabled ? "border-slate-300 dark:border-slate-800" : "border-dashed border-slate-300 opacity-80 dark:border-slate-700"}`}>
            <span className="w-6 text-right text-sm text-slate-500 dark:text-slate-400">{i + 1}</span>
            {r.hasThumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/signage/media/${r.mediaId}/thumb`} alt="" className="h-12 w-20 rounded object-cover" loading="lazy" />
            ) : (
              <span className="h-12 w-20 rounded bg-slate-200 dark:bg-slate-800" aria-hidden />
            )}
            <div className="min-w-[8rem] flex-1">
              <p className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{r.name}</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {r.kind === "video" ? `Video, ${seconds(r.mediaDurationS ?? 0)}` : "Picture"}
                {r.status !== "ready" ? ` · ${r.status}` : ""}
              </p>
            </div>
            <label className="text-xs text-slate-600 dark:text-slate-300">
              Time (s)
              <input
                type="number"
                min={1}
                max={86400}
                className={`${inputCls} w-24`}
                disabled={ro}
                value={r.durationS ?? ""}
                placeholder={r.kind === "video" ? "own" : String(imageS)}
                onChange={(e) => change((x) => x.map((y) => (y.key === r.key ? { ...y, durationS: e.target.value ? Number(e.target.value) : null } : y)))}
              />
            </label>
            <label className="text-xs text-slate-600 dark:text-slate-300">
              From
              <input type="date" className={inputCls} disabled={ro} value={r.validFrom ?? ""} onChange={(e) => change((x) => x.map((y) => (y.key === r.key ? { ...y, validFrom: e.target.value || null } : y)))} />
            </label>
            <label className="text-xs text-slate-600 dark:text-slate-300">
              Until
              <input type="date" className={inputCls} disabled={ro} value={r.validUntil ?? ""} onChange={(e) => change((x) => x.map((y) => (y.key === r.key ? { ...y, validUntil: e.target.value || null } : y)))} />
            </label>
            <label className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" disabled={ro} checked={r.enabled} onChange={(e) => change((x) => x.map((y) => (y.key === r.key ? { ...y, enabled: e.target.checked } : y)))} /> On
            </label>
            {!ro ? (
              <div className="flex gap-1">
                <button type="button" className={btnCls} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${r.name} up`}>
                  <ArrowUp className="h-4 w-4" aria-hidden />
                </button>
                <button type="button" className={btnCls} disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${r.name} down`}>
                  <ArrowDown className="h-4 w-4" aria-hidden />
                </button>
                <button type="button" className={dangerCls} onClick={() => change((x) => x.filter((y) => y.key !== r.key))} aria-label={`Remove ${r.name} from the playlist`}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      {!ro ? (
        <button type="button" className={btnCls} onClick={() => setPicking(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Add pictures or videos
        </button>
      ) : null}
      {dirty && !ro ? <p className="text-sm text-slate-600 dark:text-slate-300">Changes are not saved yet.</p> : null}

      {picking ? (
        <MediaPicker
          already={new Set(rows.map((r) => r.mediaId))}
          onClose={() => setPicking(false)}
          onPick={(list) => {
            change((r) => [
              ...r,
              ...list.map((m) => ({
                key: `new-${m.id}-${Math.random()}`,
                mediaId: m.id,
                durationS: null,
                enabled: true,
                validFrom: null,
                validUntil: null,
                name: m.name,
                kind: m.kind,
                hasThumb: m.hasThumb,
                mediaDurationS: m.durationS,
                status: m.status,
              })),
            ]);
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
}

/** The media library to add from. What the playlist already holds (`already`, including items added but not saved yet) is not offered again. */
function MediaPicker({ already, onClose, onPick }: { already: ReadonlySet<string>; onClose: () => void; onPick: (m: SignageMedia[]) => void }) {
  const { data } = useSignageJson<SignageMedia[]>("media");
  const [chosen, setChosen] = useState<string[]>([]);
  const allReady = (data ?? []).filter((m) => m.status === "ready");
  const ready = allReady.filter((m) => !already.has(m.id));
  return (
    <Modal title="Add from the media library" onClose={onClose}>
      {data === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : ready.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {allReady.length ? "Everything in the media library is already in this playlist. " : "Nothing is ready yet. "}
          <Link href="/signage/media" className="text-brand-600 underline dark:text-brand-400">
            Upload on the Media page
          </Link>
          .
        </p>
      ) : (
        <ul className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto">
          {ready.map((m) => {
            const on = chosen.includes(m.id);
            return (
              <li key={m.id}>
                <label className={`block cursor-pointer rounded border-2 p-1 text-xs ${on ? "border-brand-600" : "border-transparent"}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={() => setChosen(on ? chosen.filter((x) => x !== m.id) : [...chosen, m.id])} />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/signage/media/${m.id}/thumb`} alt="" className="aspect-video w-full rounded object-cover" loading="lazy" />
                  <span className="mt-1 block truncate text-slate-800 dark:text-slate-100">{m.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className={btnCls} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className={primaryCls} disabled={!chosen.length} onClick={() => onPick(chosen.map((cid) => ready.find((m) => m.id === cid)!).filter(Boolean))}>
          Add {chosen.length || ""}
        </button>
      </div>
    </Modal>
  );
}
