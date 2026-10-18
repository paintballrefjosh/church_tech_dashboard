"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { useCanWrite } from "./network-cisco/cisco-ui";
import { MONITORING_HEALTH_REFRESH } from "./section-tabs";

/** How long alerts can be paused for from the switch. A pause with no end is offered last, and on purpose. */
const DURATIONS: Array<{ label: string; minutes: number | null }> = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 4 * 60 },
  { label: "8 hours", minutes: 8 * 60 },
  { label: "24 hours", minutes: 24 * 60 },
  { label: "Until I turn it back on", minutes: null },
];

interface MaintenanceReply {
  enabled?: boolean;
  until?: string | null;
}

/** "18:30" for today, "Fri 18:30" otherwise (the viewer's own clock; only rendered after the first fetch, never on the server). */
function untilText(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/**
 * Compact monitoring on/off switch shown inline at the right of the Monitoring
 * tab row. It presents the inverse of the maintenance setting: "Enabled" (switch
 * on, the default) = alerts fire normally; switching it off pauses alert
 * notifications across Services, Infra, UniFi and Cisco (incidents are still
 * recorded) for a chosen time, so a pause nobody remembers ends by itself. While
 * paused it says when alerts resume, and the time can be changed. Read-only
 * users see just a small "Maintenance" indicator while it's active.
 */
export function MaintenanceControl() {
  const canWrite = useCanWrite();
  // `maintenance` is the raw state (true = alerts silenced right now); `until` is its ISO end time, if it has one.
  const [maintenance, setMaintenance] = useState<boolean | null>(null);
  const [until, setUntil] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const apply = useCallback((body: MaintenanceReply) => {
    setMaintenance(Boolean(body.enabled));
    setUntil(body.enabled && typeof body.until === "string" ? body.until : null);
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/monitors/maintenance", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) apply((await r.json()) as MaintenanceReply);
    } catch {
      /* transient */
    }
  }, [apply]);

  useEffect(() => {
    void load();
  }, [load]);

  // Something else changed it (the command palette's "Pause alerts"): look again.
  useEffect(() => {
    const onChange = () => void load();
    window.addEventListener(MONITORING_HEALTH_REFRESH, onChange);
    return () => window.removeEventListener(MONITORING_HEALTH_REFRESH, onChange);
  }, [load]);

  // When the window ends, look again so the switch goes back to "Enabled" without a reload.
  useEffect(() => {
    if (!until) return;
    const wait = new Date(until).getTime() - Date.now() + 1500;
    if (wait <= 0) return;
    const t = setTimeout(() => {
      void load();
      window.dispatchEvent(new Event(MONITORING_HEALTH_REFRESH));
    }, Math.min(wait, 2_000_000_000));
    return () => clearTimeout(t);
  }, [until, load]);

  // Close the duration menu on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const send = useCallback(
    async (payload: { enabled: boolean; minutes?: number }) => {
      if (busy) return;
      setBusy(true);
      setMenu(false);
      try {
        const r = await fetch("/api/monitors/maintenance", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (r.ok) {
          apply((await r.json()) as MaintenanceReply);
          window.dispatchEvent(new Event(MONITORING_HEALTH_REFRESH));
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, apply],
  );

  if (maintenance === null) return null;
  const enabled = !maintenance; // monitoring alerts enabled?
  const endText = until ? `until ${untilText(until)}` : "no end time";

  // Read-only users: only surface the state when alerts are being silenced.
  if (!canWrite) {
    if (!maintenance) return null;
    return (
      <span className="ml-auto mr-2 inline-flex items-center gap-1.5 self-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <BellOff className="h-3.5 w-3.5" aria-hidden /> Maintenance {endText}
      </span>
    );
  }

  return (
    <div
      ref={rootRef}
      className="relative z-40 ml-auto mr-2 flex items-center gap-2 self-center py-1"
      title={
        enabled
          ? "Monitoring alerts are enabled. Switch off to pause them for a while (incidents still record)."
          : "Maintenance mode: alert notifications are silenced across all monitoring. Incidents are still recorded."
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
        {enabled ? "Enabled" : `Maintenance, ${endText}`}
      </span>
      {!enabled ? (
        <button
          type="button"
          onClick={() => setMenu((m) => !m)}
          disabled={busy}
          aria-haspopup="menu"
          aria-expanded={menu}
          className="rounded border border-slate-300 px-1.5 py-0.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          Change
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => (enabled ? setMenu((m) => !m) : void send({ enabled: false }))}
        disabled={busy}
        role="switch"
        aria-checked={enabled}
        aria-label="Monitoring alerts enabled"
        aria-haspopup={enabled ? "menu" : undefined}
        aria-expanded={enabled ? menu : undefined}
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

      {menu ? (
        <div
          role="menu"
          aria-label="Pause alerts for"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-slate-300 bg-white p-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="px-2 py-1 text-xs text-slate-500">{enabled ? "Pause alerts for" : "Keep them paused for"}</p>
          {DURATIONS.map((d) => (
            <button
              key={d.label}
              role="menuitem"
              type="button"
              onClick={() => void send(d.minutes === null ? { enabled: true } : { enabled: true, minutes: d.minutes })}
              className={`block w-full rounded px-2 py-1.5 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${
                d.minutes === null ? "text-amber-700 dark:text-amber-300" : ""
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
