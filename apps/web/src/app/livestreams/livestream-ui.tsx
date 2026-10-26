"use client";

import { useState } from "react";
import { LIVESTREAM_PLATFORM_INFO, LIVESTREAM_PROBLEM_LABELS, type Livestream, type LivestreamProblem, type LivestreamState } from "@church/shared";

/**
 * Pieces shared by the livestream wall and a stream's page (docs/livestreams.md). The picture area is black in both
 * themes, like a multiviewer: it is video. Every state is said in words as well as by colour.
 */

export const STATE_LABEL: Record<LivestreamState, string> = {
  live: "Live",
  offline: "Off air",
  problem: "Problem",
  unknown: "Not checked yet",
  outside_hours: "Outside its hours",
  disabled: "Switched off",
  setup: "Needs setting up",
};

const STATE_CLS: Record<LivestreamState, string> = {
  live: "bg-rose-700 text-white",
  problem: "bg-amber-400 text-slate-950",
  offline: "bg-slate-700 text-white",
  unknown: "bg-slate-700 text-white",
  outside_hours: "bg-slate-700 text-white",
  disabled: "bg-slate-700 text-white",
  setup: "bg-slate-700 text-white",
};

/** The tally: red while live, amber with a problem (also when the problem is that it is not live). */
export function Tally({ s, className = "" }: { s: Pick<Livestream, "state" | "live">; className?: string }) {
  const label = s.state === "problem" && s.live ? "Live, problem" : STATE_LABEL[s.state];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ${STATE_CLS[s.state]} ${className}`}>
      {s.state === "live" || (s.state === "problem" && s.live) ? <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" /> : null}
      {label}
    </span>
  );
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export function inMinutes(iso: string | null, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return "now";
  return s < 90 ? `in ${s} s` : `in ${Math.round(s / 60)} min`;
}

export function platformLabel(s: Pick<Livestream, "platform" | "access">): string {
  return `${LIVESTREAM_PLATFORM_INFO[s.platform].label}${s.access === "private" ? " (private)" : ""}`;
}

/** The latest still, black-framed 16:9, with what to say when there is none. */
export function Picture({ s, size = "tile" }: { s: Livestream; size?: "tile" | "big" }) {
  const [broken, setBroken] = useState(false);
  const empty =
    s.state === "outside_hours" ? "Outside its hours" : s.state === "disabled" ? "Switched off" : s.state === "setup" ? "Needs setting up" : s.live === false ? "Not live" : s.sample && !s.sample.video ? "No picture in the stream" : "No picture yet";
  const showImg = s.hasSnapshot && s.live !== false && !broken;
  return (
    <div className={`relative aspect-video w-full overflow-hidden bg-black ${size === "big" ? "rounded-lg" : "rounded-t-md"}`}>
      {showImg ? (
        // A still made by the checker; not next/image (the optimizer is off in this app).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/livestreams/${s.id}/snapshot?t=${encodeURIComponent(s.snapshotAt ?? "")}`}
          alt={`Still from ${s.name}, ${ago(s.snapshotAt)}`}
          className="h-full w-full object-contain"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-slate-300">{empty}</div>
      )}
      <Tally s={s} className="absolute left-2 top-2" />
      {s.live && s.viewers !== null ? (
        <span className="absolute right-2 top-2 rounded bg-black/75 px-2 py-0.5 text-xs font-medium text-white">
          {s.viewers.toLocaleString()} watching
        </span>
      ) : null}
    </div>
  );
}

/** dB value to a 0..1 position on a meter from `floor` to 0. */
const pos = (db: number, floor: number) => Math.max(0, Math.min(1, (db - floor) / -floor));

/**
 * A horizontal level meter. `band` marks the range a church stream should sit in (loudness -24 to -14 LUFS: quieter
 * than that is hard to hear on a phone, louder is what platforms turn down). The value is always printed beside it.
 */
export function Meter({
  label,
  value,
  unit,
  floor = -60,
  band,
  quietBelow,
}: {
  label: string;
  value: number | null;
  unit: string;
  floor?: number;
  band?: [number, number];
  quietBelow?: number;
}) {
  const v = value === null ? null : Math.max(floor, value);
  const quiet = v !== null && quietBelow !== undefined && v <= quietBelow;
  const inBand = v !== null && band ? v >= band[0] && v <= band[1] : false;
  const fill = v === null ? "" : quiet ? "bg-slate-400 dark:bg-slate-500" : band && !inBand ? "bg-amber-500" : "bg-emerald-600 dark:bg-emerald-500";
  return (
    <div>
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-slate-600 dark:text-slate-300">{label}</span>
        <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
          {v === null ? "no reading" : `${value! <= floor ? `below ${floor}` : value!.toFixed(1)} ${unit}`}
          {quiet ? " (silent)" : ""}
        </span>
      </div>
      <div className="relative mt-1 h-2.5 overflow-hidden rounded-sm bg-slate-200 dark:bg-slate-800" aria-hidden>
        {band ? (
          <div
            className="absolute inset-y-0 border-x border-slate-500/60 bg-slate-300/60 dark:border-slate-400/50 dark:bg-slate-700/70"
            style={{ left: `${pos(band[0], floor) * 100}%`, width: `${(pos(band[1], floor) - pos(band[0], floor)) * 100}%` }}
          />
        ) : null}
        {v !== null ? <div className={`absolute inset-y-0 left-0 ${fill}`} style={{ width: `${Math.max(2, pos(v, floor) * 100)}%` }} /> : null}
      </div>
    </div>
  );
}

export function problemText(p: LivestreamProblem[]): string {
  return p.map((x) => LIVESTREAM_PROBLEM_LABELS[x]).join(", ");
}

/** Problems as plain sentences: confirmed ones first, then what the last sample saw and is being looked at again. */
export function ProblemLines({ s }: { s: Livestream }) {
  const pending = s.sampleProblems.filter((p) => !s.problems.includes(p));
  if (!s.problems.length && !pending.length && !s.lastError) return null;
  return (
    <ul className="space-y-1 text-sm">
      {s.problems.length ? (
        <li className="font-medium text-rose-700 dark:text-rose-300">
          {problemText(s.problems)}
          {s.problemSince ? <span className="font-normal text-slate-600 dark:text-slate-300"> (since {ago(s.problemSince)})</span> : null}
        </li>
      ) : null}
      {pending.length ? (
        <li className="text-amber-800 dark:text-amber-300">
          Last sample: {problemText(pending)}
          {s.nextSampleAt ? `, checking again ${inMinutes(s.nextSampleAt)}` : ""}
        </li>
      ) : null}
      {s.lastError ? <li className="text-slate-600 dark:text-slate-300">{s.lastError}</li> : null}
    </ul>
  );
}
