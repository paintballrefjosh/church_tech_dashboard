"use client";

import { useEffect, useState } from "react";
import type { MonitorWorkers } from "@church/shared";

const POLL_MS = 30_000;

/**
 * Per-node probe worker figures (see MonitorsService.workers). `data.clustered` is false on a single node, which
 * is the cue for every caller to show nothing extra. Null until the first answer, or if it never comes.
 */
export function useMonitorWorkers(): MonitorWorkers | null {
  const [data, setData] = useState<MonitorWorkers | null>(null);
  useEffect(() => {
    let stop = false;
    async function load() {
      if (document.visibilityState === "hidden") return;
      try {
        const r = await fetch("/api/monitors/workers", { credentials: "same-origin", cache: "no-store" });
        if (r.ok && !stop) setData((await r.json()) as MonitorWorkers);
      } catch {
        /* transient: keep what is shown */
      }
    }
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  return data;
}

/** "12s ago" / "3m ago" for a timestamp; "never" when there is none. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
