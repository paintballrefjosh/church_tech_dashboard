"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useCanWrite } from "./network-cisco/cisco-ui";
import { MONITORING_HEALTH_REFRESH } from "./section-tabs";

/**
 * Compact monitoring on/off switch shown inline at the right of the Monitoring
 * tab row. It presents the inverse of the `monitoring.maintenance_mode` setting:
 * "Enabled" (switch on, the default) = alerts fire normally; switching it off
 * turns on maintenance mode, silencing the alert fan-out across Services, Infra,
 * UniFi and Cisco (incidents are still recorded). Read-only users see just a
 * small "Maintenance" indicator while it's active.
 */
export function MaintenanceControl() {
  const canWrite = useCanWrite();
  // `maintenance` is the raw setting (true = alerts silenced).
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/monitors/maintenance", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const body = (await r.json()) as { enabled?: boolean };
        setMaintenance(Boolean(body.enabled));
      }
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (busy || maintenance === null) return;
    setBusy(true);
    const next = !maintenance;
    try {
      const r = await fetch("/api/monitors/maintenance", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (r.ok) {
        const body = (await r.json()) as { enabled?: boolean };
        setMaintenance(Boolean(body.enabled));
        window.dispatchEvent(new Event(MONITORING_HEALTH_REFRESH));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, maintenance]);

  if (maintenance === null) return null;
  const enabled = !maintenance; // monitoring alerts enabled?

  // Read-only users: only surface the state when alerts are being silenced.
  if (!canWrite) {
    if (!maintenance) return null;
    return (
      <span className="ml-auto mr-2 inline-flex items-center gap-1.5 self-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <BellOff className="h-3.5 w-3.5" aria-hidden /> Maintenance
      </span>
    );
  }

  return (
    <div
      className="ml-auto mr-2 flex items-center gap-2 self-center py-1"
      title={
        enabled
          ? "Monitoring alerts are enabled. Switch off for maintenance mode (silences alert notifications; incidents still record)."
          : "Maintenance mode — alert notifications are silenced across all monitoring. Incidents are still recorded."
      }
    >
      {enabled ? (
        <Bell className="h-4 w-4 text-emerald-500" aria-hidden />
      ) : (
        <BellOff className="h-4 w-4 text-amber-500" aria-hidden />
      )}
      <span
        className={`text-xs font-medium ${
          enabled ? "text-slate-600 dark:text-slate-300" : "text-amber-700 dark:text-amber-300"
        }`}
      >
        {enabled ? "Enabled" : "Maintenance"}
      </span>
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        role="switch"
        aria-checked={enabled}
        aria-label="Monitoring alerts enabled"
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          enabled ? "bg-emerald-500" : "bg-amber-500"
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
            enabled ? "translate-x-4" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}
