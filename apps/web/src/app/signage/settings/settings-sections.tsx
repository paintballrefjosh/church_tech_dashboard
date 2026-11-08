"use client";

import { useRef, useState } from "react";
import { KeyRound, PackageOpen } from "lucide-react";
import type { SignageAgentRelease, SignageKeyInfo } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { ErrorLine, bytes, btnCls, dangerCls, primaryCls, useSignageJson, when } from "../signage-ui";

/** The dashboard's SSH key: what the Pis trust, and moving every Pi to a new one. */
export function KeySection() {
  const key = useSignageJson<SignageKeyInfo>("key");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function rotate() {
    if (!window.confirm("Make a new key and move every Pi to it? Pis that cannot be reached now keep the old key until you apply settings to them again.")) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await sendJson<SignageKeyInfo & { queued: number; notQueued: Array<{ name: string; error: string }> }>("/api/signage/key/rotate", "POST");
      setMsg({ ok: r.notQueued.length === 0, text: `New key made. ${r.queued} Pi${r.queued === 1 ? "" : "s"} queued to move.${r.notQueued.length ? ` Not queued: ${r.notQueued.map((n) => `${n.name} (${n.error})`).join(", ")}.` : ""}` });
      void key.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="sig-key" className="space-y-2 rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <h2 id="sig-key" className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
        <KeyRound className="h-4 w-4" aria-hidden /> The dashboard&apos;s SSH key
      </h2>
      <p className="text-sm text-slate-600 dark:text-slate-300">Made from the site&apos;s secret, so every node has the same one and nothing is stored. Setup puts the public half on each Pi.</p>
      {key.error ? <ErrorLine text={key.error} /> : null}
      {key.data ? (
        <>
          <p className="text-sm text-slate-700 dark:text-slate-200">
            Key {key.data.generation} · <span className="font-mono text-xs">{key.data.fingerprint}</span>
            {key.data.devicesOnOldKey ? <span className="text-amber-800 dark:text-amber-300"> · {key.data.devicesOnOldKey} Pi{key.data.devicesOnOldKey === 1 ? "" : "s"} still on an older key</span> : null}
          </p>
          <pre tabIndex={0} role="region" aria-label="Public key" className="overflow-x-auto rounded-md bg-slate-100 p-2 font-mono text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200">
            {key.data.publicKey}
          </pre>
          <button type="button" className={dangerCls} disabled={busy} onClick={() => void rotate()}>
            {busy ? "Moving…" : "Make a new key"}
          </button>
        </>
      ) : null}
      {msg ? <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{msg.text}</p> : null}
    </section>
  );
}

/** The Pi agent: the built-in version, uploaded ones, which is current, and rolling it out. */
export function ReleasesSection() {
  const releases = useSignageJson<SignageAgentRelease[]>("releases");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const r = await fetch(`/api/signage/releases?notes=${encodeURIComponent(notes)}`, { method: "POST", body: fd, credentials: "same-origin" });
      const j = (await r.json().catch(() => null)) as { message?: string | string[]; version?: string } | null;
      if (!r.ok) throw new Error(Array.isArray(j?.message) ? j.message.join("; ") : (j?.message ?? `Upload failed (${r.status})`));
      setMsg({ ok: true, text: `Agent ${j?.version ?? ""} uploaded.` });
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
      void releases.reload();
    } catch (e2) {
      setMsg({ ok: false, text: (e2 as Error).message });
    } finally {
      setBusy(false);
    }
  }
  async function act(fn: () => Promise<string>) {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
      void releases.reload();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sig-rel" className="space-y-3 rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sig-rel" className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
          <PackageOpen className="h-4 w-4" aria-hidden /> Pi agent versions
        </h2>
        <button
          type="button"
          className={primaryCls}
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const r = await sendJson<{ version: string; queued: number }>("/api/signage/releases/rollout", "POST");
              return `Agent ${r.version}: update queued on ${r.queued} Pi${r.queued === 1 ? "" : "s"}.`;
            })
          }
        >
          Update every Pi to the current version
        </button>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">The version shipped with this dashboard is used unless you pick another. An upload is the agent folder as a .tar.gz; it is checked before it is kept.</p>
      {releases.data?.length ? (
        <ul className="space-y-1 text-sm">
          {releases.data.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 dark:border-slate-800">
              <span>
                <span className="font-medium text-slate-900 dark:text-slate-100">{r.version}</span>
                {r.builtIn ? " (shipped with the dashboard)" : ` · ${bytes(r.sizeBytes)} · ${when(r.createdAt)}`} · on {r.devices} Pi{r.devices === 1 ? "" : "s"}
                {r.isCurrent ? <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-800 dark:bg-brand-900 dark:text-brand-100">Current</span> : null}
                {r.notes ? <span className="block text-xs text-slate-500 dark:text-slate-400">{r.notes}</span> : null}
              </span>
              {!r.isCurrent ? (
                <button type="button" className={btnCls} disabled={busy} aria-label={`Use agent ${r.version}`} onClick={() => void act(async () => { await sendJson(`/api/signage/releases/${r.id}/current`, "POST"); return `Agent ${r.version} is now current.`; })}>
                  Use this one
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={upload} className="flex flex-wrap items-end gap-2">
        <span>
          <label htmlFor="sig-rel-file" className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Upload a version
          </label>
          <input id="sig-rel-file" ref={fileRef} type="file" accept=".tar.gz,.tgz,application/gzip" className="text-sm text-slate-700 dark:text-slate-200" required />
        </span>
        <span className="min-w-[200px] flex-1">
          <label htmlFor="sig-rel-notes" className="block text-sm font-medium text-slate-700 dark:text-slate-200">
            Notes (optional)
          </label>
          <input id="sig-rel-notes" className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </span>
        <button type="submit" className={btnCls} disabled={busy}>
          Upload
        </button>
      </form>
      {msg ? <p className={`text-sm ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-700 dark:text-rose-300"}`}>{msg.text}</p> : null}
    </section>
  );
}
