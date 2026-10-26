"use client";

import { useEffect, useId, useState } from "react";
import { Save } from "lucide-react";
import {
  LIVESTREAM_LIMITS,
  LIVESTREAM_PLATFORMS,
  LIVESTREAM_PLATFORM_INFO,
  SAVED_SECRET,
  type Livestream,
  type LivestreamAccess,
  type LivestreamPlatform,
  type LivestreamPlatformTest,
} from "@church/shared";
import { Modal, inputCls } from "../monitoring/network-cisco/cisco-ui";
import { sendJson } from "@/components/assets-ui";

interface Choices {
  groups: Array<{ id: string; name: string }>;
  monitors: Array<{ id: string; name: string; kind: string }>;
}

const STATUS_EVERY = [30, 60, 120, 300, 600];
const SAMPLE_EVERY = [60, 120, 300, 600, 900, 1800, 3600];
const SAMPLE_FOR = [5, 10, 15, 20, 30];
/** Monitor kinds that are an encoder or a switcher, listed first in the encoder picker. */
const ENCODER_KINDS = ["atem", "obs", "vmix", "hyperdeck", "hls"];

const every = (s: number) => (s < 60 ? `${s} seconds` : s < 3600 ? `${s / 60} minute${s === 60 ? "" : "s"}` : "hour");

/** Add or edit a stream. A saved private link is never shown: the field stays empty and keeps it unless something is typed. */
export function LivestreamFormModal({ initial, onClose, onSaved }: { initial: Livestream | null; onClose: () => void; onSaved: (s: Livestream) => void }) {
  const ids = { platform: useId(), page: useId(), link: useId(), ref: useId(), sched: useId(), group: useId(), enc: useId() };
  const [name, setName] = useState(initial?.name ?? "");
  const [platform, setPlatform] = useState<LivestreamPlatform>(initial?.platform ?? "youtube");
  const [access, setAccess] = useState<LivestreamAccess>(initial?.access ?? "public");
  const [pageUrl, setPageUrl] = useState(initial?.pageUrl ?? "");
  const [streamUrl, setStreamUrl] = useState("");
  const [removeLink, setRemoveLink] = useState(false);
  const [platformRef, setPlatformRef] = useState(initial?.platformRef ?? "");
  const [schedule, setSchedule] = useState(initial?.schedule ?? "");
  const [graceMin, setGraceMin] = useState(initial?.graceMin ?? 5);
  const [statusIntervalSec, setStatusIntervalSec] = useState(initial?.statusIntervalSec ?? 60);
  const [sampleIntervalSec, setSampleIntervalSec] = useState(initial?.sampleIntervalSec ?? 300);
  const [sampleSeconds, setSampleSeconds] = useState(initial?.sampleSeconds ?? 10);
  const [silenceDb, setSilenceDb] = useState(initial?.silenceDb ?? -50);
  const [checkVideo, setCheckVideo] = useState(initial?.checkVideo ?? true);
  const [alertGroupId, setAlertGroupId] = useState<string | null>(initial?.alertGroupId ?? null);
  const [encoderMonitorId, setEncoderMonitorId] = useState<string | null>(initial?.encoderMonitorId ?? null);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [resi, setResi] = useState<LivestreamPlatformTest | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const info = LIVESTREAM_PLATFORM_INFO[platform];

  useEffect(() => {
    fetch("/api/livestreams/choices", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Choices>) : null))
      .then((c) => setChoices(c))
      .catch(() => setChoices(null));
  }, []);

  async function loadResi() {
    setResi(null);
    const r = await fetch("/api/livestreams/platforms/resi/encoders", { credentials: "same-origin", cache: "no-store" });
    setResi(r.ok ? ((await r.json()) as LivestreamPlatformTest) : { ok: false, message: `Resi could not be asked (${r.status}).`, items: [] });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        platform,
        access,
        pageUrl: pageUrl.trim(),
        platformRef: platformRef.trim(),
        schedule: schedule.trim(),
        graceMin,
        statusIntervalSec,
        sampleIntervalSec,
        sampleSeconds,
        silenceDb,
        checkVideo,
        alertGroupId,
        encoderMonitorId,
        enabled,
        streamUrl: removeLink || access === "public" ? (initial?.hasStreamUrl ? null : undefined) : streamUrl.trim() ? streamUrl.trim() : initial?.hasStreamUrl ? SAVED_SECRET : null,
      };
      const saved = initial ? await sendJson<Livestream>(`/api/livestreams/${initial.id}`, "PATCH", body) : await sendJson<Livestream>("/api/livestreams", "POST", body);
      onSaved(saved);
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const encoderOptions = (choices?.monitors ?? []).slice().sort((a, b) => Number(!ENCODER_KINDS.includes(a.kind)) - Number(!ENCODER_KINDS.includes(b.kind)) || a.name.localeCompare(b.name));

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add a livestream"} onClose={onClose}>
      <form onSubmit={submit} className="max-h-[75vh] space-y-3 overflow-y-auto pr-1 text-sm">
        <label className="block">
          <span className="text-xs text-slate-600 dark:text-slate-300">Name</span>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday 10:30 on YouTube" className={inputCls} />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.platform} className="text-xs text-slate-600 dark:text-slate-300">Platform</label>
            <select id={ids.platform} value={platform} onChange={(e) => setPlatform(e.target.value as LivestreamPlatform)} className={inputCls}>
              {LIVESTREAM_PLATFORMS.map((p) => (
                <option key={p} value={p}>{LIVESTREAM_PLATFORM_INFO[p].label}</option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className="text-xs text-slate-600 dark:text-slate-300">Who can watch it</legend>
            <div className="mt-2 flex gap-4">
              {(["public", "private"] as const).map((a) => (
                <label key={a} className="inline-flex items-center gap-1.5">
                  <input type="radio" name="access" value={a} checked={access === a} onChange={() => setAccess(a)} />
                  {a === "public" ? "Anyone (public)" : "Private or unlisted"}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div>
          <label htmlFor={ids.page} className="text-xs text-slate-600 dark:text-slate-300">
            {info.pageResolves ? "The stream's page" : "The stream's link"}{access === "private" && platform !== "youtube" ? " (optional, for the link on this page)" : ""}
          </label>
          <input id={ids.page} type="url" maxLength={4000} value={pageUrl} onChange={(e) => setPageUrl(e.target.value)} className={`${inputCls} font-mono text-xs`} placeholder="https://" aria-describedby={`${ids.page}-hint`} />
          <p id={`${ids.page}-hint`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">{info.publicHint}</p>
        </div>

        {access === "private" ? (
          <div>
            <label htmlFor={ids.link} className="text-xs text-slate-600 dark:text-slate-300">Private link (kept encrypted, never shown again)</label>
            <input
              id={ids.link}
              type="password"
              autoComplete="off"
              maxLength={4000}
              value={streamUrl}
              onChange={(e) => setStreamUrl(e.target.value)}
              disabled={removeLink}
              placeholder={initial?.hasStreamUrl ? "A link is saved: paste a new one to replace it" : "https://...m3u8?token=..."}
              className={`${inputCls} font-mono text-xs`}
              aria-describedby={`${ids.link}-hint`}
            />
            <p id={`${ids.link}-hint`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">{info.privateHint}</p>
            {initial?.hasStreamUrl ? (
              <label className="mt-1 inline-flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={removeLink} onChange={(e) => setRemoveLink(e.target.checked)} /> Remove the saved link
              </label>
            ) : null}
          </div>
        ) : null}

        {info.refLabel ? (
          <div>
            <label htmlFor={ids.ref} className="text-xs text-slate-600 dark:text-slate-300">{info.refLabel} (optional)</label>
            <div className="flex gap-2">
              <input id={ids.ref} maxLength={200} value={platformRef} onChange={(e) => setPlatformRef(e.target.value)} className={`${inputCls} font-mono text-xs`} />
              {platform === "resi" ? (
                <button type="button" onClick={() => void loadResi()} className="mt-1 shrink-0 rounded-md border border-slate-300 px-3 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                  List encoders
                </button>
              ) : null}
            </div>
            {resi ? (
              <div className="mt-1 text-xs">
                <p className={resi.ok ? "text-slate-600 dark:text-slate-300" : "text-rose-700 dark:text-rose-300"}>{resi.message}</p>
                <ul className="mt-1 space-y-1">
                  {resi.items.map((it) => (
                    <li key={it.id}>
                      <button type="button" onClick={() => setPlatformRef(it.id)} className="text-brand-600 hover:underline dark:text-brand-400">
                        {it.name}
                      </button>
                      {it.detail ? <span className="text-slate-500 dark:text-slate-400"> ({it.detail})</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}

        <fieldset className="space-y-3 rounded-md border border-slate-300 p-3 dark:border-slate-700">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">When it should be live</legend>
          <div>
            <label htmlFor={ids.sched} className="text-xs text-slate-600 dark:text-slate-300">Schedule (blank = checked all the time, never "should be live")</label>
            <input id={ids.sched} maxLength={500} value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="Sun 10:15-12:15; Wed 19:00-20:30" className={`${inputCls} font-mono text-xs`} />
          </div>
          <label className="block max-w-xs">
            <span className="text-xs text-slate-600 dark:text-slate-300">Minutes into the window before "not live" counts</span>
            <input type="number" min={0} max={120} value={graceMin} onChange={(e) => setGraceMin(parseInt(e.target.value, 10) || 0)} className={inputCls} />
          </label>
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border border-slate-300 p-3 sm:grid-cols-3 dark:border-slate-700">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">How often</legend>
          <label className="block">
            <span className="text-xs text-slate-600 dark:text-slate-300">Is it live: every</span>
            <select value={statusIntervalSec} onChange={(e) => setStatusIntervalSec(Number(e.target.value))} className={inputCls}>
              {STATUS_EVERY.filter((s) => s >= LIVESTREAM_LIMITS.statusMinSec).map((s) => (
                <option key={s} value={s}>{every(s)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-600 dark:text-slate-300">Sound and picture: every</span>
            <select value={sampleIntervalSec} onChange={(e) => setSampleIntervalSec(Number(e.target.value))} className={inputCls}>
              {SAMPLE_EVERY.map((s) => (
                <option key={s} value={s}>{every(s)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs text-slate-600 dark:text-slate-300">Listening for</span>
            <select value={sampleSeconds} onChange={(e) => setSampleSeconds(Number(e.target.value))} className={inputCls}>
              {SAMPLE_FOR.map((s) => (
                <option key={s} value={s}>{s} seconds</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400 sm:col-span-3">
            A sample that finds a problem is taken again {LIVESTREAM_LIMITS.confirmAfterSec} seconds later; only a problem both show is reported.
          </p>
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border border-slate-300 p-3 sm:grid-cols-2 dark:border-slate-700">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">What counts as a problem</legend>
          <label className="block">
            <span className="text-xs text-slate-600 dark:text-slate-300">Silent at or below (dB)</span>
            <input type="number" min={-90} max={-20} value={silenceDb} onChange={(e) => setSilenceDb(parseInt(e.target.value, 10) || -50)} className={inputCls} />
          </label>
          <label className="mt-5 inline-flex items-center gap-2">
            <input type="checkbox" checked={checkVideo} onChange={(e) => setCheckVideo(e.target.checked)} />
            <span>A frozen or black picture is a problem</span>
          </label>
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={ids.group} className="text-xs text-slate-600 dark:text-slate-300">Tell this group</label>
            <select id={ids.group} value={alertGroupId ?? ""} onChange={(e) => setAlertGroupId(e.target.value || null)} className={inputCls}>
              <option value="">Monitoring's usual recipients</option>
              {(choices?.groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={ids.enc} className="text-xs text-slate-600 dark:text-slate-300">Encoder or switcher monitor (shown on the page)</label>
            <select id={ids.enc} value={encoderMonitorId ?? ""} onChange={(e) => setEncoderMonitorId(e.target.value || null)} className={inputCls}>
              <option value="">None</option>
              {encoderOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.name} ({m.kind})</option>
              ))}
            </select>
          </div>
        </div>
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Checked (untick to pause it)
        </label>

        {err ? <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{err}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
            <Save className="h-4 w-4" aria-hidden /> {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
