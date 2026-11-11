"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ListVideo, Plus } from "lucide-react";
import type { SignagePlaylist } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { ErrorLine, Forbidden, Label, btnCls, inputCls, primaryCls, seconds, useSignageJson, useSignagePerms } from "../signage-ui";

/** Playlists: pictures and videos in order, each shown for its time. The schedule says which plays where and when. */
export default function SignagePlaylistsPage() {
  const perms = useSignagePerms();
  const { data, forbidden } = useSignageJson<SignagePlaylist[]>("playlists");
  const [adding, setAdding] = useState(false);
  if (forbidden) return <Forbidden />;
  const rows = (data ?? []).filter((p) => !p.isAdhoc);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageTitle icon={ListVideo}>Playlists</PageTitle>
        {perms.write ? (
          <button type="button" className={primaryCls} onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" aria-hidden /> New playlist
          </button>
        ) : null}
      </div>
      {data === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          No playlists yet. Upload pictures and videos on the Media page, then make a playlist of them.
        </p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {rows.map((p) => (
            <li key={p.id} className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
              <Link href={`/signage/playlists/${p.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                {p.name}
              </Link>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {p.items.length} item{p.items.length === 1 ? "" : "s"} · one loop {seconds(p.loopSeconds)}
              </p>
              {p.description ? <p className="text-sm text-slate-500 dark:text-slate-400">{p.description}</p> : null}
              <div className="mt-2 flex gap-1 overflow-hidden" aria-hidden>
                {p.items.slice(0, 8).map((it) =>
                  it.hasThumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={it.id} src={`/api/signage/media/${it.mediaId}/thumb`} alt="" className="h-10 w-16 rounded object-cover" loading="lazy" />
                  ) : (
                    <span key={it.id} className="h-10 w-16 rounded bg-slate-200 dark:bg-slate-800" />
                  ),
                )}
              </div>
              {p.warnings.length ? <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">{p.warnings[0]}</p> : null}
            </li>
          ))}
        </ul>
      )}
      {adding ? <NewPlaylistModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function NewPlaylistModal({ onClose }: { onClose: () => void }) {
  const id = useId();
  const router = useRouter();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const p = await sendJson<SignagePlaylist>("/api/signage/playlists", "POST", { name: name.trim() });
      router.push(`/signage/playlists/${p.id}`);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  return (
    <Modal title="New playlist" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor={id}>Name</Label>
          <input id={id} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday welcome" maxLength={120} required />
        </div>
        <ErrorLine text={err} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btnCls} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={primaryCls} disabled={!name.trim()}>
            Make it
          </button>
        </div>
      </form>
    </Modal>
  );
}
