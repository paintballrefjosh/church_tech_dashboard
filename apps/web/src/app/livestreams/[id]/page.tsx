"use client";

import { use, useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { PERMISSIONS, type Livestream, type LivestreamCheck } from "@church/shared";
import { can, sendJson, useViewer } from "@/components/assets-ui";
import { GoneNotice } from "@/components/gone-notice";
import { usePoll } from "@/lib/use-poll";
import { ToastStack, cardCls, useToasts } from "../../monitoring/network-cisco/cisco-ui";
import { Meter, Picture, ProblemLines, STATE_LABEL, Tally, ago, inMinutes, platformLabel, problemText } from "../livestream-ui";
import { LivestreamFormModal } from "../livestream-form";

const HOURS = [3, 24, 168] as const;

const every = (sec: number) => (sec < 60 ? `${sec} seconds` : sec < 3600 ? `${Math.round(sec / 60)} min` : `${Math.round(sec / 3600)} h`);

/** One stream: the big picture, its sound, what the last samples found and its last day. */
export default function LivestreamPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const me = useViewer();
  const [s, setS] = useState<Livestream | null>(null);
  const [gone, setGone] = useState(false);
  const [history, setHistory] = useState<LivestreamCheck[] | null>(null);
  const [hours, setHours] = useState<(typeof HOURS)[number]>(24);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  const canWrite = can(me, PERMISSIONS.LIVESTREAMS_WRITE_ANY);
  const canDelete = can(me, PERMISSIONS.LIVESTREAMS_ADMIN);

  const load = useCallback(async () => {
    const [r, h] = await Promise.all([
      fetch(`/api/livestreams/${id}`, { credentials: "same-origin", cache: "no-store" }),
      fetch(`/api/livestreams/${id}/history?hours=${hours}`, { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (r.status === 404 || r.status === 400) return setGone(true);
    if (r.ok) setS((await r.json()) as Livestream);
    if (h.ok) setHistory((await h.json()) as LivestreamCheck[]);
  }, [id, hours]);
  usePoll(load, 15_000);

  async function checkNow() {
    setChecking(true);
    try {
      setS(await sendJson<Livestream>(`/api/livestreams/${id}/check`, "POST"));
      show(true, "Checked.");
      void load();
    } catch (e) {
      show(false, (e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function remove() {
    if (!s || !window.confirm(`Delete ${s.name}? Its history goes too.`)) return;
    try {
      await sendJson(`/api/livestreams/${id}`, "DELETE");
      router.push("/livestreams");
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  if (gone) return <GoneNotice what="This livestream" backHref="/livestreams" backLabel="All livestreams" />;
  if (!s) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  const sample = s.sample;
  const [left, right] = sample?.channelRmsDb ?? [];

  return (
    <div className="space-y-6">
      <Link href="/livestreams" className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All livestreams
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {s.name} <Tally s={s} />
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {platformLabel(s)}
            {s.liveTitle ? <> · &ldquo;{s.liveTitle}&rdquo;</> : null}
            {s.live && s.liveStartedAt ? ` · live since ${ago(s.liveStartedAt)}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canWrite ? (
            <>
              <button onClick={() => void checkNow()} disabled={checking} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                <RefreshCw className={`h-4 w-4 ${checking ? "motion-safe:animate-spin" : ""}`} aria-hidden /> {checking ? "Checking (up to a minute)…" : "Check now"}
              </button>
              <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
                <Pencil className="h-4 w-4" aria-hidden /> Edit
              </button>
            </>
          ) : null}
          {canDelete ? (
            <button onClick={() => void remove()} className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950">
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          ) : null}
        </div>
      </div>

      {s.setupProblem ? <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{s.setupProblem}</p> : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          <Picture s={s} size="big" />
          <ProblemLines s={s} />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Live checked {ago(s.statusCheckedAt)}
            {s.source ? ` (from the ${s.source === "api" ? "platform's API" : s.source === "page" ? "public page" : "stream link"})` : ""}. Sound and picture sampled {ago(s.sampledAt)}
            {s.nextSampleAt ? `, next ${inMinutes(s.nextSampleAt)}` : ""}.
          </p>
        </div>

        <div className="space-y-4">
          <section className={cardCls} aria-labelledby="ls-sound">
            <h2 id="ls-sound" className="text-sm font-semibold">Sound</h2>
            {sample?.audio ? (
              <div className="mt-3 space-y-3">
                <Meter label="Loudness (whole sample)" value={sample.loudnessLufs} unit="LUFS" band={[-24, -14]} quietBelow={s.silenceDb + 3} />
                <Meter label="Loudest moment" value={sample.peakDb} unit="dBFS" />
                {left !== undefined ? <Meter label="Left" value={left} unit="dB" quietBelow={s.silenceDb} /> : null}
                {right !== undefined ? <Meter label="Right" value={right} unit="dB" quietBelow={s.silenceDb} /> : null}
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {sample.audio.codec}, {sample.audio.channels ?? "?"}
                  {sample.audio.sampleRate ? `, ${sample.audio.sampleRate / 1000} kHz` : ""}. Silent for {sample.silentSec} of {sample.seconds} s. The shaded band is
                  where a church stream should sit (-24 to -14 LUFS).
                </p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{sample ? "The stream carries no sound track." : "No sample yet."}</p>
            )}
          </section>
          <section className={cardCls} aria-labelledby="ls-picture">
            <h2 id="ls-picture" className="text-sm font-semibold">Picture</h2>
            {sample?.video ? (
              <dl className="mt-2 grid grid-cols-2 gap-y-1 text-sm">
                <dt className="text-slate-500 dark:text-slate-400">Size</dt>
                <dd>{sample.video.width && sample.video.height ? `${sample.video.width} x ${sample.video.height}` : "?"}{sample.video.fps ? `, ${sample.video.fps} fps` : ""}</dd>
                <dt className="text-slate-500 dark:text-slate-400">Frozen</dt>
                <dd>{sample.frozenSec} of {sample.seconds} s</dd>
                <dt className="text-slate-500 dark:text-slate-400">Black</dt>
                <dd>{sample.blackSec} of {sample.seconds} s</dd>
                {sample.bitrate ? (
                  <>
                    <dt className="text-slate-500 dark:text-slate-400">Read at</dt>
                    <dd>{(sample.bitrate / 1_000_000).toFixed(1)} Mb/s</dd>
                  </>
                ) : null}
              </dl>
            ) : (
              <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{sample ? "The stream carries no picture." : "No sample yet."}</p>
            )}
            {!s.checkVideo ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">A frozen or black picture is not reported for this stream.</p> : null}
          </section>
          {s.encoder || s.platformStatus ? (
            <section className={cardCls} aria-labelledby="ls-encoder">
              <h2 id="ls-encoder" className="text-sm font-semibold">Encoder</h2>
              {s.encoder ? (
                <p className="mt-2 text-sm">
                  <Link href={`/monitoring/${s.encoder.id}`} className="text-brand-600 hover:underline dark:text-brand-400">{s.encoder.name}</Link>:{" "}
                  <span className={s.encoder.status === "down" ? "font-medium text-rose-700 dark:text-rose-300" : ""}>{s.encoder.status}</span>
                  {s.encoder.info ? <span className="text-slate-600 dark:text-slate-300"> ({s.encoder.info})</span> : null}
                </p>
              ) : null}
              {s.platformStatus ? <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{s.platformStatus}</p> : null}
            </section>
          ) : null}
        </div>
      </div>

      <section aria-labelledby="ls-history" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ls-history" className="text-sm font-semibold">History</h2>
          <div role="group" aria-label="How far back" className="flex gap-1">
            {HOURS.map((h) => (
              <button key={h} onClick={() => setHours(h)} aria-pressed={hours === h} className={`rounded px-2 py-1 text-xs ${hours === h ? "bg-brand-600 text-white" : "border border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"}`}>
                {h < 48 ? `${h} hours` : "7 days"}
              </button>
            ))}
          </div>
        </div>
        <HistoryStrip rows={history ?? []} hours={hours} />
      </section>

      <section className={cardCls} aria-labelledby="ls-setup">
        <h2 id="ls-setup" className="text-sm font-semibold">How it is checked</h2>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-slate-500 dark:text-slate-400">Read from</dt>
          <dd className="break-all">
            {s.access === "private" && s.hasStreamUrl ? "A private link (saved, not shown)" : s.pageUrl ? <a href={s.pageUrl} target="_blank" rel="noreferrer noopener" className="text-brand-600 hover:underline dark:text-brand-400">{s.pageUrl}</a> : "Nothing yet"}
          </dd>
          <dt className="text-slate-500 dark:text-slate-400">Should be live</dt>
          <dd>{s.schedule ? `${s.schedule} (after ${s.graceMin} minutes)` : "No schedule: never reported as not live"}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Is it live</dt>
          <dd>every {every(s.statusIntervalSec)}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Sound and picture</dt>
          <dd>{s.sampleSeconds} s every {every(s.sampleIntervalSec)}, silent at or below {s.silenceDb} dB</dd>
          <dt className="text-slate-500 dark:text-slate-400">Problems go to</dt>
          <dd>{s.alertGroupName ?? "Monitoring's usual recipients"}</dd>
          <dt className="text-slate-500 dark:text-slate-400">State</dt>
          <dd>{STATE_LABEL[s.state]}</dd>
        </dl>
      </section>

      {editing ? (
        <LivestreamFormModal
          initial={s}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setS(saved);
            show(true, "Saved. It is checked again within a few seconds.");
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

/**
 * The stream's recent past: a band that is red while it was live and grey while it was not, a dot per sample at its loudness
 * (amber when the sample found a problem), and a short list of the problems underneath for anyone who cannot see the chart.
 */
function HistoryStrip({ rows, hours }: { rows: LivestreamCheck[]; hours: number }) {
  const W = 1000;
  const H = 120;
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const x = (iso: string) => ((new Date(iso).getTime() - start) / (end - start)) * W;
  const y = (lufs: number) => 20 + (Math.min(0, Math.max(-60, lufs)) / -60) * (H - 40);
  const bands: Array<{ x0: number; x1: number; live: boolean | null }> = [];
  rows.forEach((r, i) => {
    const next = rows[i + 1];
    bands.push({ x0: Math.max(0, x(r.ts)), x1: next ? x(next.ts) : W, live: r.live });
  });
  const samples = rows.filter((r) => r.kind === "sample" && r.loudnessLufs !== null);
  const bad = rows.filter((r) => r.problems.length);
  const liveCount = rows.filter((r) => r.live).length;
  const summary = rows.length ? `${rows.length} readings over ${hours} hours, ${liveCount} live, ${bad.length} with a problem.` : `No readings in the last ${hours} hours.`;
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary} className="h-32 w-full rounded-md border border-slate-300 bg-white dark:border-slate-800 dark:bg-slate-950">
        {bands.map((b, i) => (
          <rect key={i} x={b.x0} y={H - 12} width={Math.max(0.5, b.x1 - b.x0)} height={12} className={b.live ? "fill-rose-600" : b.live === false ? "fill-slate-300 dark:fill-slate-700" : "fill-transparent"} />
        ))}
        {[-14, -24].map((l) => (
          <line key={l} x1={0} x2={W} y1={y(l)} y2={y(l)} className="stroke-slate-300 dark:stroke-slate-700" strokeDasharray="6 6" vectorEffect="non-scaling-stroke" />
        ))}
        {samples.map((r, i) => (
          <circle key={i} cx={x(r.ts)} cy={y(r.loudnessLufs!)} r={4} vectorEffect="non-scaling-stroke" className={r.problems.length ? "fill-amber-500" : "fill-emerald-600 dark:fill-emerald-500"} />
        ))}
      </svg>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {summary} Bottom band: red = live, grey = not live. Dots: loudness of each sample (dashed lines at -14 and -24 LUFS); amber = a problem.
      </p>
      {bad.length ? (
        <ul className="space-y-0.5 text-xs text-slate-600 dark:text-slate-300">
          {bad.slice(-8).reverse().map((r) => (
            <li key={r.ts}>
              {ago(r.ts)}: {problemText(r.problems)}
              {r.error ? ` (${r.error})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
