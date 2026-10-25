"use client";

import { useEffect, useRef } from "react";

/**
 * Call `fn` every `intervalMs` while this browser tab is visible. A hidden tab (another tab in front, a minimised
 * window, a locked phone) asks the server for nothing; when it becomes visible again it catches up at once if a turn
 * was missed. Booth and kiosk screens are visible, so they keep polling.
 *
 * `enabled: false` stops the loop (a page whose realtime socket is up polls only while it is down). `immediate`
 * (default true) also calls `fn` once when the loop starts. `fn` may change between renders; the latest one is called.
 */
export function usePoll(
  fn: () => unknown,
  intervalMs: number,
  { enabled = true, immediate = true }: { enabled?: boolean; immediate?: boolean } = {},
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!enabled) return;
    let last = 0;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const run = () => {
      last = Date.now();
      void fnRef.current();
    };
    if (immediate) run();
    else last = Date.now();
    const t = setInterval(() => {
      if (visible()) run();
    }, intervalMs);
    const onVisibility = () => {
      if (visible() && Date.now() - last >= intervalMs) run();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, immediate, intervalMs]);
}
