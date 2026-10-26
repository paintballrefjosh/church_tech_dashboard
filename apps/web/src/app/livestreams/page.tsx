"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { MonitorPlay, Plus } from "lucide-react";
import { PERMISSIONS, type Livestream } from "@church/shared";
import { PageTitle } from "@/components/page-title";
import { can, useViewer } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Meter, Picture, ProblemLines, ago, platformLabel } from "./livestream-ui";
import { LivestreamFormModal } from "./livestream-form";

/** Every stream as a tile, like a multiviewer: its latest still, whether it is live, its loudness and any problem. */
export default function LivestreamsPage() {
  const me = useViewer();
  const [rows, setRows] = useState<Livestream[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [adding, setAdding] = useState(false);
  const canWrite = can(me, PERMISSIONS.LIVESTREAMS_WRITE_ANY);

  const load = useCallback(async () => {
    const r = await fetch("/api/livestreams", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setRows((await r.json()) as Livestream[]);
  }, []);
  usePoll(load, 15_000);

  if (forbidden) return <p className="text-sm text-slate-600 dark:text-slate-300">Your groups do not include Livestreams.</p>;

  const live = rows?.filter((s) => s.live).length ?? 0;
  const problems = rows?.filter((s) => s.state === "problem").length ?? 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={MonitorPlay}>Livestreams</PageTitle>
          {rows && rows.length ? (
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {live} of {rows.length} live{problems ? `, ${problems} with a problem` : ""}. Sound and picture are sampled every few minutes while a stream is live.
            </p>
          ) : null}
        </div>
        {canWrite ? (
          <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
            <Plus className="h-4 w-4" aria-hidden /> Add a stream
          </button>
        ) : null}
      </div>

      {rows === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-6 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">
          <p className="font-medium text-slate-900 dark:text-slate-100">No streams yet.</p>
          <p className="mt-1">
            Add the page your service streams to (a YouTube channel&apos;s live page, a Facebook page, a Resi or other HLS link). The dashboard then says
            whether it is live when it should be, and listens to it and looks at it every few minutes.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-col rounded-md border border-slate-300 dark:border-slate-800">
              <Link href={`/livestreams/${s.id}`} aria-label={`${s.name}: open`} className="block focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
                <Picture s={s} />
              </Link>
              <div className="flex flex-1 flex-col gap-2 p-3">
                <div>
                  <Link href={`/livestreams/${s.id}`} className="font-medium text-slate-900 hover:underline dark:text-slate-100">
                    {s.name}
                  </Link>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {platformLabel(s)} · checked {ago(s.statusCheckedAt)}
                    {s.encoder ? ` · ${s.encoder.name} ${s.encoder.status}` : ""}
                  </p>
                </div>
                {s.live && s.sample ? <Meter label="Loudness" value={s.sample.loudnessLufs} unit="LUFS" band={[-24, -14]} quietBelow={s.silenceDb + 3} /> : null}
                <ProblemLines s={s} />
                {s.setupProblem ? <p className="text-sm text-amber-800 dark:text-amber-300">{s.setupProblem}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <LivestreamFormModal
          initial={null}
          onClose={() => setAdding(false)}
          onSaved={(s) => {
            setAdding(false);
            window.location.assign(`/livestreams/${s.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
