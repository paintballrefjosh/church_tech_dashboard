"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js once per session. Pure side effect — renders nothing.
 * Skips in dev (Next's HMR + service workers don't mix cleanly) and bails
 * silently on browsers without SW support.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    if (window.location.hostname === "localhost" && process.env.NODE_ENV !== "production") {
      return;
    }
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
