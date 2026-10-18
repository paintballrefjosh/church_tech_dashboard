"use client";

import { useMemo, useState, useTransition } from "react";
import { DASHBOARD_LOOKS, LOOK_IDS, type LookId } from "@church/shared";

export interface HomePageSettingsProps {
  timezone: string;
  defaultTheme: LookId;
  enabledThemes: LookId[];
  streamMonitorIds: string[];
  /** Null when the admin cannot read monitors: the stream monitors field is then hidden. */
  monitors: Array<{ id: string; name: string }> | null;
}

function supportedZones(): string[] {
  const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  try {
    const zones = fn ? fn("timeZone") : [];
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC"];
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

async function saveSetting(key: string, value: unknown): Promise<string | null> {
  const r = await fetch(`/admin/settings/save/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value }),
    credentials: "same-origin",
  });
  if (r.ok) return null;
  try {
    const j = (await r.json()) as { error?: string };
    return j.error ?? `Save failed (${r.status})`;
  } catch {
    return `Save failed (${r.status})`;
  }
}

const field =
  "mt-1 block w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:border-slate-700 dark:bg-slate-900";

export function HomePageSettings(props: HomePageSettingsProps) {
  const zones = useMemo(supportedZones, []);
  const [timezone, setTimezone] = useState(props.timezone);
  const [defaultTheme, setDefaultTheme] = useState<LookId>(props.defaultTheme);
  const [enabled, setEnabled] = useState<LookId[]>(props.enabledThemes);
  const [streamIds, setStreamIds] = useState<string[]>(props.streamMonitorIds);
  const [saving, startTransition] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  function toggleLook(id: LookId, on: boolean) {
    setEnabled((prev) => (on ? LOOK_IDS.filter((l) => l === id || prev.includes(l)) : prev.filter((l) => l !== id)));
  }

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    if (!zones.includes(timezone)) {
      setStatus({ ok: false, text: `"${timezone}" is not a known time zone. Pick one from the list.` });
      return;
    }
    if (enabled.length === 0) {
      setStatus({ ok: false, text: "Offer at least one look." });
      return;
    }
    startTransition(async () => {
      const tasks: Array<Promise<string | null>> = [];
      if (timezone !== props.timezone) tasks.push(saveSetting("site.timezone", timezone));
      if (defaultTheme !== props.defaultTheme) tasks.push(saveSetting("dashboard.default_theme", defaultTheme));
      if (!sameSet(enabled, props.enabledThemes)) tasks.push(saveSetting("dashboard.enabled_themes", enabled));
      if (props.monitors && !sameSet(streamIds, props.streamMonitorIds)) {
        tasks.push(saveSetting("dashboard.stream_monitor_ids", streamIds));
      }
      if (tasks.length === 0) {
        setStatus({ ok: true, text: "Nothing changed." });
        return;
      }
      const failures = (await Promise.all(tasks)).filter((m): m is string => m !== null);
      setStatus(
        failures.length > 0
          ? { ok: false, text: failures.join(" ") }
          : { ok: true, text: "Saved. People see the new settings the next time they open the home page." },
      );
    });
  }

  return (
    <section aria-labelledby="home-page-heading" className="mt-6">
      <h2 id="home-page-heading" className="text-lg font-medium">
        Home page
      </h2>
      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
        Which looks people can choose from, which one they start with, and the time zone behind the greeting and the
        week.
      </p>
      <form
        onSubmit={onSave}
        className="mt-4 space-y-5 rounded-md border border-slate-300 p-4 dark:border-slate-800"
        data-testid="home-page-settings"
      >
        <label className="block text-sm">
          <span className="font-medium">Time zone</span>
          <input
            list="home-timezones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className={field}
          />
          <datalist id="home-timezones">
            {zones.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Start typing a city or region, for example Europe/London. Sets the day boundaries and greeting.
          </span>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Default look</span>
          <select
            value={defaultTheme}
            onChange={(e) => setDefaultTheme(e.target.value as LookId)}
            className={field}
          >
            {LOOK_IDS.map((id) => (
              <option key={id} value={id}>
                {DASHBOARD_LOOKS.find((l) => l.id === id)?.name ?? id}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
            Shown to people who have not chosen one. If it is switched off below or needs access someone lacks, they
            get the Start page.
          </span>
        </label>

        <fieldset className="text-sm">
          <legend className="font-medium">Offered looks</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {DASHBOARD_LOOKS.map((l) => (
              <label key={l.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={enabled.includes(l.id)}
                  onChange={(e) => toggleLook(l.id, e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-brand-600"
                />
                <span>
                  {l.name}
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{l.description}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Offer at least one. The Start page is always available as the fallback, even when unticked.
          </p>
        </fieldset>

        {props.monitors ? (
          <label className="block text-sm">
            <span className="font-medium">Stream monitors</span>
            <select
              multiple
              size={Math.min(8, Math.max(3, props.monitors.length))}
              value={streamIds}
              onChange={(e) => setStreamIds(Array.from(e.target.selectedOptions, (o) => o.value))}
              className={field}
            >
              {props.monitors.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500 dark:text-slate-400">
              Monitors that must be up for the Stream readiness check. Select none to leave the check out. Hold Ctrl or
              Cmd to select several.
            </span>
          </label>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-brand-600 px-4 py-2 text-sm text-white hover:bg-brand-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save home page settings"}
          </button>
          <span role="status" className="text-sm">
            {status ? (
              <span className={status.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
                {status.text}
              </span>
            ) : null}
          </span>
        </div>
      </form>
    </section>
  );
}
