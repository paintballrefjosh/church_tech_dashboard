"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Trash2, Power, AlertTriangle, CircleCheck, CircleHelp } from "lucide-react";
import type { Monitor, MonitorCheck, MonitorIncident } from "@church/shared";
import { useRealtimeRoom } from "@/lib/use-realtime";

export function MonitorDetailClient({
  initialMonitor,
  initialHistory,
  initialIncidents,
}: {
  initialMonitor: Monitor;
  initialHistory: MonitorCheck[];
  initialIncidents: MonitorIncident[];
}) {
  const router = useRouter();
  const [monitor, setMonitor] = useState(initialMonitor);
  const [history, setHistory] = useState(initialHistory);
  const [incidents, setIncidents] = useState(initialIncidents);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Pull the current monitor + its recent check history (the latter feeds the
  // chart, so we refetch rather than merge a delta). Driven by realtime events
  // from this monitor's room; a slow poll only runs while the socket is down.
  const id = initialMonitor.id;
  const refresh = useCallback(async () => {
    try {
      const [m, h] = await Promise.all([
        fetch(`/api/monitors/${id}`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/monitors/${id}/history?limit=240`, {
          credentials: "same-origin",
          cache: "no-store",
        }),
      ]);
      if (m.ok) setMonitor((await m.json()) as Monitor);
      if (h.ok) setHistory((await h.json()) as MonitorCheck[]);
    } catch {
      /* ignore transient errors */
    }
  }, [id]);

  const { connected } = useRealtimeRoom(
    `monitor:${id}`,
    { "monitor:update": () => void refresh(), "monitor:incident": () => void refresh() },
    () => void refresh(),
  );

  useEffect(() => {
    if (connected) return;
    const t = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(t);
  }, [connected, refresh]);

  async function destroy() {
    if (!confirm(`Delete monitor "${monitor.name}"? This cannot be undone.`)) return;
    setErr(null);
    setDeleting(true);
    try {
      const r = await fetch(`/api/monitors/${monitor.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (r.ok) router.push("/monitoring");
      else {
        setErr(`Delete failed (${r.status})`);
        setDeleting(false);
      }
    } catch {
      setErr("Delete failed — network error");
      setDeleting(false);
    }
  }

  const oldestFirst = [...history].reverse();
  const successCount = oldestFirst.filter((c) => c.ok).length;
  const uptimePct = oldestFirst.length ? (100 * successCount) / oldestFirst.length : 0;
  const avgLatency = (() => {
    const l = oldestFirst.map((c) => c.latencyMs ?? 0).filter((n) => n > 0);
    return l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : 0;
  })();

  return (
    <div className="space-y-4 text-sm">
      <section className="grid gap-3 sm:grid-cols-4">
        <Stat
          label="Status"
          value={<StatusBadge status={monitor.status} enabled={monitor.enabled} />}
        />
        <Stat
          label="Last check"
          value={
            monitor.lastCheckedAt
              ? `${monitor.lastLatencyMs ?? "?"} ms · ${new Date(monitor.lastCheckedAt).toLocaleTimeString()}`
              : "—"
          }
        />
        <Stat label="Uptime (recent)" value={`${uptimePct.toFixed(1)}%`} />
        <Stat label="Avg latency" value={`${avgLatency} ms`} />
      </section>

      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Recent history</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Oldest on the left, newest on the right. Hover for timestamp + result.
        </p>
        <div className="mt-3">
          <Sparkline history={oldestFirst} />
        </div>
      </section>

      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Incidents</h2>
        {incidents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            No incidents recorded.
          </p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 text-xs dark:divide-slate-800">
            {incidents.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                {i.resolvedAt ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {i.resolvedAt ? "Resolved" : "Open"}
                    {i.reason ? ` — ${i.reason}` : ""}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    started {new Date(i.startedAt).toLocaleString()}
                    {i.resolvedAt
                      ? ` · resolved ${new Date(i.resolvedAt).toLocaleString()}`
                      : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex items-center justify-between rounded-md border border-rose-200 p-4 text-xs dark:border-rose-900/50">
        <div>
          <div className="text-sm font-medium text-rose-700 dark:text-rose-300">Delete monitor</div>
          <div className="text-rose-600/80 dark:text-rose-400/80">
            Removes the monitor and all of its history. Cannot be undone.
          </div>
        </div>
        <button
          type="button"
          onClick={destroy}
          disabled={deleting}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
        >
          <Trash2 className="h-4 w-4" aria-hidden /> {deleting ? "Deleting…" : "Delete"}
        </button>
      </section>
      {err ? <p className="text-rose-600 dark:text-rose-400">{err}</p> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-base font-medium">{value}</div>
    </div>
  );
}

function StatusBadge({ status, enabled }: { status: string; enabled: boolean }) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
        <Power className="h-4 w-4" aria-hidden /> Paused
      </span>
    );
  }
  if (status === "up")
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="h-4 w-4" aria-hidden /> Up
      </span>
    );
  if (status === "down")
    return (
      <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Down
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
      <CircleHelp className="h-4 w-4" aria-hidden /> Unknown
    </span>
  );
}

// Anything slower than this (and still ok=true) renders amber, so a slow
// monitor visually distinguishes from a healthy one even before it crosses
// into a hard failure. Latency-encoded heights are too easy to overlook for
// brief spikes — colour is the load-bearing signal here.
const DEGRADED_LATENCY_MS = 1500;

function severity(c: MonitorCheck): "down" | "degraded" | "up" {
  if (!c.ok) return "down";
  if (c.latencyMs !== null && c.latencyMs > DEGRADED_LATENCY_MS) return "degraded";
  return "up";
}

function Sparkline({ history }: { history: MonitorCheck[] }) {
  if (history.length === 0) {
    return <p className="text-xs text-slate-500">No checks recorded yet.</p>;
  }
  // Healthy bars stay latency-encoded so the eye spots trends. Down + degraded
  // bars render full height so a single bad check among hundreds of fast ones
  // can't disappear into an 8% stub.
  const maxLatency = 1000;
  return (
    <>
      {/* flex-1 on each bar makes the row span the full container width
          regardless of how many checks are in `history` or how wide the
          page is (matters once the per-user pageWidth lets the column grow
          to 1536+px). min-w-[2px] keeps a hoverable target even at 240+
          bars. Reduced gap-px so 240 bars don't collapse into hairlines. */}
      <div className="flex h-16 items-end gap-px">
        {history.map((c) => {
          const sev = severity(c);
          const colour =
            sev === "down"
              ? "bg-rose-500"
              : sev === "degraded"
                ? "bg-amber-500"
                : "bg-emerald-500";
          const pct =
            sev === "up"
              ? c.latencyMs
                ? Math.min(100, (c.latencyMs / maxLatency) * 100)
                : 100
              : 100;
          const label =
            sev === "down" ? "FAIL" : sev === "degraded" ? "SLOW" : "OK";
          return (
            <div
              key={c.id}
              title={`${new Date(c.ts).toLocaleString()} · ${label} · ${c.latencyMs ?? "?"}ms · ${c.info ?? ""}`}
              className={`min-w-[2px] flex-1 rounded-sm ${colour}`}
              style={{ height: `${Math.max(8, pct)}%` }}
            />
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-slate-500 dark:text-slate-400">
        <SparklineKey colour="bg-emerald-500" label="OK" />
        <SparklineKey colour="bg-amber-500" label={`Slow (> ${DEGRADED_LATENCY_MS}ms)`} />
        <SparklineKey colour="bg-rose-500" label="Failure" />
      </div>
    </>
  );
}

function SparklineKey({ colour, label }: { colour: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`inline-block h-2 w-2 rounded-sm ${colour}`} aria-hidden />
      {label}
    </span>
  );
}
