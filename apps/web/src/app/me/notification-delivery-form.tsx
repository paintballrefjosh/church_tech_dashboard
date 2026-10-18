"use client";

import { useEffect, useState } from "react";
import { Moon, Save } from "lucide-react";
import { DEFAULT_NOTIFICATION_DELIVERY, formatClock, parseClock, type NotificationDelivery } from "@church/shared";

interface Loaded extends NotificationDelivery {
  timeZone: string;
}

/**
 * When to be disturbed: quiet hours, a once-a-day email summary, and whether urgent "something is down" alerts ignore both.
 * Times are on the church's clock (the site time zone), whatever this device says. The rules are in
 * packages/shared/src/notification-delivery.ts.
 */
export function NotificationDeliveryForm() {
  const [value, setValue] = useState<NotificationDelivery>(DEFAULT_NOTIFICATION_DELIVERY);
  const [zone, setZone] = useState("UTC");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/v1/me/notification-delivery", { credentials: "same-origin", cache: "no-store" });
        if (r.ok) {
          const { timeZone, ...rest } = (await r.json()) as Loaded;
          if (!cancelled) {
            setValue(rest);
            setZone(timeZone);
          }
        }
      } catch {
        /* keep the defaults */
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = (patch: Partial<NotificationDelivery>) => {
    setValue((v) => ({ ...v, ...patch }));
    setOk(null);
  };
  const time = (key: "quietStart" | "quietEnd" | "digestAt") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const m = parseClock(e.target.value);
    if (m !== null) change({ [key]: m });
  };

  async function save() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await fetch("/api/v1/me/notification-delivery", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(value),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: unknown };
        setErr(typeof body.message === "string" ? body.message : "That did not save. Check the times and try again.");
        return;
      }
      setOk("Saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading...</p>;

  const box = "h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 focus:ring-brand-500 dark:border-slate-700 dark:bg-slate-900";
  const timeInput =
    "rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm disabled:opacity-50 dark:border-slate-700 dark:bg-slate-950";

  return (
    <div className="space-y-4" data-testid="delivery-form">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className={box} checked={value.quietEnabled} onChange={(e) => change({ quietEnabled: e.target.checked })} data-testid="delivery-quiet" />
          <Moon className="h-4 w-4 text-slate-500 dark:text-slate-400" aria-hidden />
          Quiet hours
        </label>
        <div className="ml-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
            From
            <input
              type="time"
              value={formatClock(value.quietStart)}
              onChange={time("quietStart")}
              disabled={!value.quietEnabled}
              className={timeInput}
              data-testid="delivery-quiet-start"
            />
          </label>
          <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
            until
            <input
              type="time"
              value={formatClock(value.quietEnd)}
              onChange={time("quietEnd")}
              disabled={!value.quietEnabled}
              className={timeInput}
              data-testid="delivery-quiet-end"
            />
          </label>
        </div>
        <p className="ml-6 text-xs text-slate-500 dark:text-slate-400">
          No push notices in these hours. Email waits and arrives together when they end. The bell still fills quietly.
        </p>
      </div>

      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className={box} checked={value.digestEnabled} onChange={(e) => change({ digestEnabled: e.target.checked })} data-testid="delivery-digest" />
          Send my email as one daily summary
        </label>
        <div className="ml-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-300">
            Send it at
            <input
              type="time"
              value={formatClock(value.digestAt)}
              onChange={time("digestAt")}
              disabled={!value.digestEnabled}
              className={timeInput}
              data-testid="delivery-digest-at"
            />
          </label>
        </div>
        <p className="ml-6 text-xs text-slate-500 dark:text-slate-400">
          Instead of an email for each notice, you get one a day listing them. Push notices are not affected.
        </p>
      </div>

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" className={box} checked={value.urgentThrough} onChange={(e) => change({ urgentThrough: e.target.checked })} data-testid="delivery-urgent" />
          Let urgent alerts through anyway
        </label>
        <p className="ml-6 text-xs text-slate-500 dark:text-slate-400">
          A service, server or switch going down, or an incident nobody has picked up, reaches you at once by push and email, even in quiet hours
          or with the daily summary on.
        </p>
      </div>

      <p className="text-xs text-slate-500 dark:text-slate-400">
        Times are on the church&apos;s clock ({zone}).
      </p>

      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          data-testid="delivery-save"
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> Save
        </button>
        {err ? <span role="alert" className="text-rose-600 dark:text-rose-400">{err}</span> : null}
        {ok ? <span role="status" className="text-emerald-700 dark:text-emerald-400">{ok}</span> : null}
      </div>
    </div>
  );
}
