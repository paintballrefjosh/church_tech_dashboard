"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HomeInclude, HomeSnapshot } from "@church/shared";
import { useRealtimeRoom } from "@/lib/use-realtime";

/** The window event the Monitoring pages dispatch after a mutation (see monitoring/section-tabs.tsx). */
const HEALTH_REFRESH_EVENT = "monitoring:health-refresh";

export const POLL_MS = 30_000;
/** Realtime signals (probe results, host polls) arrive often; refetch at most this often for them. */
export const REALTIME_MIN_GAP_MS = 5_000;
/** Focus and "a mutation just happened" signals wait at most this long after the last fetch. */
const SIGNAL_MIN_GAP_MS = 1_000;

export interface UseHomeSnapshot {
  snapshot: HomeSnapshot;
  /** Fetch now (deduplicated with a fetch already running). Resolves when the snapshot is updated. */
  refresh: () => Promise<void>;
  refreshing: boolean;
  /** The last refresh failed; the previous snapshot is still in `snapshot`. */
  error: string | null;
}

/**
 * Keeps a home snapshot fresh. Starts from `initial` (rendered on the server) and refetches
 * `/api/dashboard/home` every 30 s while the tab is visible, when the window regains focus, when a
 * Monitoring page announces a change (`monitoring:health-refresh`), and on realtime signals from
 * the `monitoring` and `infra` rooms, but only when the person can read monitors (their `systems`
 * section is not `forbidden`).
 *
 * It deliberately does not join the `network` room: the UniFi poller hits the controller
 * continuously while anyone is in it. The server reads a cached UniFi summary instead.
 *
 * On any failure the last good snapshot stays on screen and `error` is set.
 */
export function useHomeSnapshot(initial: HomeSnapshot, includes: readonly HomeInclude[]): UseHomeSnapshot {
  const [snapshot, setSnapshot] = useState<HomeSnapshot>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const includeKey = includes.join(",");
  const inflight = useRef<Promise<void> | null>(null);
  const lastStart = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const keyRef = useRef(includeKey);
  keyRef.current = includeKey;

  const fetchNow = useCallback((): Promise<void> => {
    if (inflight.current) return inflight.current;
    lastStart.current = Date.now();
    const key = keyRef.current;
    const run = (async () => {
      setRefreshing(true);
      try {
        const qs = key ? `?include=${encodeURIComponent(key)}` : "";
        const res = await fetch(`/api/dashboard/home${qs}`, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        const next = (await res.json()) as HomeSnapshot;
        if (!alive.current || key !== keyRef.current) return;
        setSnapshot(next);
        setError(null);
      } catch (err) {
        if (alive.current) setError(err instanceof Error ? err.message : "could not refresh");
      } finally {
        inflight.current = null;
        if (alive.current) setRefreshing(false);
      }
    })();
    inflight.current = run;
    return run;
  }, []);

  /** Ask for a refresh no sooner than `minGap` after the last one started; one request pending at most. */
  const request = useCallback(
    (minGap: number) => {
      if (timer.current) return;
      const wait = Math.max(0, lastStart.current + minGap - Date.now());
      timer.current = setTimeout(() => {
        timer.current = null;
        void fetchNow();
      }, wait);
    },
    [fetchNow],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  // Poll while visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void fetchNow();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [fetchNow]);

  // Focus and Monitoring-page mutations.
  useEffect(() => {
    const onSignal = () => request(SIGNAL_MIN_GAP_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") onSignal();
    };
    window.addEventListener("focus", onSignal);
    window.addEventListener(HEALTH_REFRESH_EVENT, onSignal);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onSignal);
      window.removeEventListener(HEALTH_REFRESH_EVENT, onSignal);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [request]);

  // A different set of optional parts needs a fresh answer straight away.
  const firstKey = useRef(true);
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    void (inflight.current ?? Promise.resolve()).then(() => fetchNow());
  }, [includeKey, fetchNow]);

  // A newer server-rendered snapshot (after router.refresh) replaces an older one.
  useEffect(() => {
    setSnapshot((cur) => (Date.parse(initial.generatedAt) > Date.parse(cur.generatedAt) ? initial : cur));
  }, [initial]);

  // Realtime: only for people who can read monitors. No rooms means no socket is opened.
  const canMonitor = snapshot.systems.state !== "forbidden";
  const onSignal = useCallback(() => request(REALTIME_MIN_GAP_MS), [request]);
  useRealtimeRoom(canMonitor ? ["monitoring", "infra"] : [], {
    "monitor:update": onSignal,
    "infra:update": onSignal,
  });

  return { snapshot, refresh: fetchNow, refreshing, error };
}
