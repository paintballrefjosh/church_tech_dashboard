"use client";

import { AlertTriangle, Server } from "lucide-react";
import { checkBuilds, type MonitorWorker } from "@church/shared";
import { ago, useMonitorWorkers } from "./use-monitor-workers";

/**
 * Multi-node deployments only: every app node runs a probe worker and the workers share the monitors, so a
 * check can come from any node. One card per node shows whether it is heartbeating and what it checked lately.
 * Renders nothing on a single node.
 */
export function WorkersStrip() {
  const workers = useMonitorWorkers();
  if (!workers?.clustered) return null;

  const total = workers.nodes.reduce((n, w) => n + w.checks, 0);
  const builds = checkBuilds(workers.nodes.map((w) => ({ id: w.nodeId, version: w.version ?? null, live: w.live })));
  return (
    <section
      aria-label="Probe workers by node"
      className={`mb-4 rounded-md border p-3 ${
        builds.mismatch ? "border-rose-300 dark:border-rose-900" : "border-slate-300 dark:border-slate-800"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
          <Server className="h-3.5 w-3.5" aria-hidden /> Probe workers
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {workers.nodes.length} nodes share {workers.enabledMonitors} enabled monitor
          {workers.enabledMonitors === 1 ? "" : "s"}; each check is made by one node. Last {workers.windowMin} min:{" "}
          {total} checks.
        </p>
      </div>
      {builds.mismatch ? (
        <p
          role="alert"
          className="mb-2 flex items-start gap-2 rounded-md border border-rose-300 bg-rose-50 p-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            The nodes are not all running the same build:{" "}
            {builds.groups.map((g, i) => (
              <span key={g.version}>
                {i > 0 ? "; " : ""}
                <span className="font-mono">{g.version}</span> on {g.nodes.join(", ")}
              </span>
            ))}
            . Expected during a rolling upgrade; otherwise a node was not upgraded.
          </span>
        </p>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {workers.nodes.map((w) => (
          <WorkerCard
            key={w.nodeId}
            worker={w}
            total={total}
            windowMin={workers.windowMin}
            buildDiffers={builds.odd.has(w.nodeId)}
          />
        ))}
      </ul>
    </section>
  );
}

function WorkerCard({
  worker: w,
  total,
  windowMin,
  buildDiffers,
}: {
  worker: MonitorWorker;
  total: number;
  windowMin: number;
  buildDiffers: boolean;
}) {
  const share = total > 0 ? Math.round((100 * w.checks) / total) : 0;
  return (
    <li
      className={`rounded-md border p-2.5 text-xs ${
        buildDiffers
          ? "border-rose-400 bg-rose-50 dark:border-rose-700 dark:bg-rose-950/40"
          : "border-slate-200 dark:border-slate-800"
      }`}
      data-build-differs={buildDiffers ? "true" : undefined}
    >
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${w.live ? "bg-emerald-500" : "bg-rose-500"}`}
          aria-hidden
        />
        <span className="truncate font-mono text-sm font-medium">{w.nodeId}</span>
        <span className={`ml-auto shrink-0 ${w.live ? "text-slate-500 dark:text-slate-400" : "font-medium text-rose-600 dark:text-rose-400"}`}>
          {w.live ? "online" : "not heartbeating"}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[11px]">
        <span className="text-slate-400">build</span>
        <span
          className={`truncate font-mono ${
            buildDiffers ? "font-semibold text-rose-700 dark:text-rose-300" : "text-slate-600 dark:text-slate-300"
          }`}
          title={w.version ?? "this node did not report a build"}
        >
          {w.version ?? "unknown"}
        </span>
        {buildDiffers ? (
          <span className="ml-auto shrink-0 rounded border border-rose-300 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-rose-700 dark:border-rose-700 dark:text-rose-300">
            differs
          </span>
        ) : null}
      </div>
      {w.checks === 0 ? (
        <p className="mt-2 text-slate-500 dark:text-slate-400">
          No checks in the last {windowMin} min
          {w.live ? " (the other nodes took them)" : ""}.
        </p>
      ) : (
        <>
          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
            title={`${share}% of the checks`}
          >
            <div className="h-full bg-brand-600" style={{ width: `${share}%` }} />
          </div>
          <dl className="mt-2 grid grid-cols-3 gap-2">
            <Fig label="Checks" value={`${w.checks} (${share}%)`} />
            <Fig
              label="Failures"
              value={String(w.failures)}
              tone={w.failures > 0 ? "text-rose-600 dark:text-rose-400" : undefined}
            />
            <Fig label="Avg latency" value={w.avgLatencyMs == null ? "-" : `${w.avgLatencyMs} ms`} />
          </dl>
          <p className="mt-1.5 text-[11px] text-slate-400">last check {ago(w.lastCheckAt)}</p>
        </>
      )}
    </li>
  );
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`font-medium ${tone ?? ""}`}>{value}</dd>
    </div>
  );
}
