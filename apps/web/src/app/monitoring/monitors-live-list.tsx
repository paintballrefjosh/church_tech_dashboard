"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CircleCheck,
  CircleHelp,
  Power,
  RefreshCw,
} from "lucide-react";
import type { Monitor } from "@church/shared";
import { useRealtimeRoom } from "@/lib/use-realtime";
import { useMonitorWorkers } from "./use-monitor-workers";

/**
 * Live monitor list. The prober pushes a `monitor:update` delta over the
 * `monitoring` room on every check, which we merge into the row by id — so the
 * list updates the instant a new reading lands rather than on a fetch loop. A
 * full refetch runs on each (re)connect (to pick up adds/removes/toggles
 * missed while offline) and a slow poll only kicks in while the socket is down.
 */
const FALLBACK_POLL_MS = 20_000;

/** Mutable fields the prober pushes; merged into the Monitor row by id. */
interface MonitorUpdate {
  id: string;
  status: Monitor["status"];
  enabled: boolean;
  lastLatencyMs: number | null;
  lastCheckedAt: string;
  lastCheckedBy?: string | null;
  consecutiveFails: number;
  consecutiveOks: number;
}

export function MonitorsLiveList({ initial }: { initial: Monitor[] }) {
  const [monitors, setMonitors] = useState<Monitor[]>(initial);
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const [busy, setBusy] = useState(false);
  const inflight = useRef(false);
  // On a multi-node deployment each row says which node made its latest check.
  const clustered = useMonitorWorkers()?.clustered ?? false;

  const refresh = useCallback(async () => {
    // Skip if a previous tick hasn't returned yet — prevents pile-up if the
    // API is slow or the tab was backgrounded.
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      const r = await fetch("/api/monitors", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (r.ok) {
        setMonitors((await r.json()) as Monitor[]);
        setLastUpdated(new Date());
      }
    } catch {
      /* transient — try again next tick */
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, []);

  const onUpdate = useCallback((payload: unknown) => {
    const u = payload as MonitorUpdate;
    if (!u || typeof u.id !== "string") return;
    setMonitors((prev) => prev.map((m) => (m.id === u.id ? ({ ...m, ...u } as Monitor) : m)));
    setLastUpdated(new Date());
  }, []);

  const { connected } = useRealtimeRoom(
    "monitoring",
    { "monitor:update": onUpdate },
    () => void refresh(),
  );

  // Fallback poll only while the socket is down.
  useEffect(() => {
    if (connected) return;
    function tickIfVisible() {
      if (document.visibilityState === "visible") void refresh();
    }
    const t = setInterval(tickIfVisible, FALLBACK_POLL_MS);
    document.addEventListener("visibilitychange", tickIfVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tickIfVisible);
    };
  }, [connected, refresh]);

  if (monitors.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        No monitors yet.{" "}
        <Link href="/monitoring/new" className="text-brand-600 underline">
          Add one
        </Link>{" "}
        to start probing.
      </p>
    );
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-1.5 text-[10px] uppercase tracking-wide text-slate-400">
        <RefreshCw className={`h-3 w-3 ${busy ? "animate-spin" : ""}`} aria-hidden />
        <span>live · updated {lastUpdated.toLocaleTimeString()}</span>
      </div>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
        {monitors.map((m) => (
          <li key={m.id}>
            <Link
              href={`/monitoring/${m.id}`}
              className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
            >
              <StatusDot status={m.status} enabled={m.enabled} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{m.name}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {m.kind}
                  </span>
                  {!m.enabled ? (
                    <span className="inline-flex items-center gap-1 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-700 dark:bg-slate-700 dark:text-slate-200">
                      <Power className="h-3 w-3" aria-hidden /> paused
                    </span>
                  ) : null}
                </div>
                <div className="truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                  {m.target}
                </div>
              </div>
              <div className="hidden w-40 text-right text-xs text-slate-500 dark:text-slate-400 sm:block">
                {m.lastCheckedAt
                  ? `${m.lastLatencyMs ?? "?"} ms · ${new Date(m.lastCheckedAt).toLocaleTimeString()}`
                  : "no checks yet"}
                {clustered && m.lastCheckedAt && m.lastCheckedBy ? (
                  <div className="truncate font-mono text-[11px] text-slate-400" title="Node that made the latest check">
                    via {m.lastCheckedBy}
                  </div>
                ) : null}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusDot({ status, enabled }: { status: string; enabled: boolean }) {
  if (!enabled) {
    return <Power className="h-5 w-5 shrink-0 text-slate-400" aria-label="Disabled" />;
  }
  if (status === "up") {
    return <CircleCheck className="h-5 w-5 shrink-0 text-emerald-500" aria-label="Up" />;
  }
  if (status === "down") {
    return <AlertTriangle className="h-5 w-5 shrink-0 text-rose-500" aria-label="Down" />;
  }
  return <CircleHelp className="h-5 w-5 shrink-0 text-slate-400" aria-label="Unknown" />;
}
