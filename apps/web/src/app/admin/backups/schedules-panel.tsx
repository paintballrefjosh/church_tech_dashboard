"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarClock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { BackupFrequency, BackupOperation, BackupSchedule, BackupScheduleInput } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";
import { api, post, useOperation } from "./client-api";
import { ErrorNote, OperationProgress } from "./operation-progress";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WHEN: Intl.DateTimeFormatOptions = { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function describeSchedule(s: Pick<BackupSchedule, "frequency" | "time" | "dayOfWeek" | "dayOfMonth" | "timezone" | "keep" | "includeFiles">): string {
  const when =
    s.frequency === "daily"
      ? "Every day"
      : s.frequency === "weekly"
        ? `Every ${WEEKDAYS[s.dayOfWeek]}`
        : `On the ${ordinal(s.dayOfMonth)} of every month`;
  return `${when} at ${s.time} (${s.timezone}). Keeps the latest ${s.keep}${s.includeFiles ? ", with uploaded files" : ", without uploaded files"}.`;
}

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function zoneList(): string[] {
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const zones = anyIntl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    // older browser
  }
  return ["UTC", "Europe/London", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];
}

interface FormState {
  name: string;
  enabled: boolean;
  frequency: BackupFrequency;
  time: string;
  dayOfWeek: number;
  dayOfMonth: number;
  timezone: string;
  keep: number;
  includeFiles: boolean;
}

const blank = (): FormState => ({
  name: "",
  enabled: true,
  frequency: "daily",
  time: "03:00",
  dayOfWeek: 0,
  dayOfMonth: 1,
  timezone: browserZone(),
  keep: 7,
  includeFiles: true,
});

const input = "mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900";
const label = "block text-xs font-medium text-slate-600 dark:text-slate-400";

function ScheduleForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  submitLabel: string;
  onSubmit: (v: FormState) => Promise<void>;
  onCancel: () => void;
}) {
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = useMemo(() => {
    const list = zoneList();
    return list.includes(v.timezone) ? list : [v.timezone, ...list];
  }, [v.timezone]);
  const set = <K extends keyof FormState>(k: K, value: FormState[K]) => setV((p) => ({ ...p, [k]: value }));

  return (
    <form
      className="grid gap-3 rounded-md border border-slate-300 p-4 sm:grid-cols-2 dark:border-slate-700"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit(v);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      data-testid="schedule-form"
    >
      <label className="text-sm sm:col-span-2">
        <span className={label}>Name</span>
        <input name="name" className={input} value={v.name} onChange={(e) => set("name", e.target.value)} maxLength={120} required placeholder="e.g. Nightly backup" />
      </label>
      <label className="text-sm">
        <span className={label}>How often</span>
        <select name="frequency" className={input} value={v.frequency} onChange={(e) => set("frequency", e.target.value as BackupFrequency)}>
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
      </label>
      <label className="text-sm">
        <span className={label}>At</span>
        <input name="time" className={input} type="time" value={v.time} onChange={(e) => set("time", e.target.value)} required />
      </label>
      {v.frequency === "weekly" ? (
        <label className="text-sm">
          <span className={label}>On</span>
          <select name="dayOfWeek" className={input} value={v.dayOfWeek} onChange={(e) => set("dayOfWeek", Number(e.target.value))}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>{d}</option>
            ))}
          </select>
        </label>
      ) : null}
      {v.frequency === "monthly" ? (
        <label className="text-sm">
          <span className={label}>On day of the month (1-28)</span>
          <input name="dayOfMonth" className={input} type="number" min={1} max={28} value={v.dayOfMonth} onChange={(e) => set("dayOfMonth", Number(e.target.value))} required />
        </label>
      ) : null}
      <label className="text-sm">
        <span className={label}>Time zone</span>
        <select name="timezone" className={input} value={v.timezone} onChange={(e) => set("timezone", e.target.value)}>
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className={label}>Keep the latest</span>
        <input name="keep" className={input} type="number" min={1} max={365} value={v.keep} onChange={(e) => set("keep", Number(e.target.value))} required />
        <span className="mt-0.5 block text-[11px] text-slate-500">Older backups from this schedule are deleted automatically.</span>
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={v.includeFiles} onChange={(e) => set("includeFiles", e.target.checked)} />
        Include uploaded files
      </label>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} />
        Enabled
      </label>
      <p className="text-xs text-slate-500 sm:col-span-2">{describeSchedule(v)}</p>
      {error ? <div className="sm:col-span-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {busy ? "Saving..." : submitLabel}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-slate-300 px-3.5 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
          Cancel
        </button>
      </div>
    </form>
  );
}

export function SchedulesPanel({ initialSchedules, runningOperation }: { initialSchedules: BackupSchedule[]; runningOperation: BackupOperation | null }) {
  const [schedules, setSchedules] = useState(initialSchedules);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSchedules(await api<BackupSchedule[]>("/schedules"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const { op, track } = useOperation(async (finished) => {
    if (finished.status === "failed") setError(finished.error ?? "The backup failed.");
    await refresh();
  });
  useEffect(() => {
    if (runningOperation?.kind === "backup") track(runningOperation.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toInput = (v: FormState): BackupScheduleInput => ({ ...v });

  async function create(v: FormState) {
    const made = await post<BackupSchedule>("/schedules", toInput(v), "Couldn't create the schedule");
    setSchedules((p) => [...p, made].sort((a, b) => a.name.localeCompare(b.name)));
    setCreating(false);
  }
  async function update(id: string, v: FormState) {
    const next = await api<BackupSchedule>(`/schedules/${id}`, { method: "PATCH", body: JSON.stringify(toInput(v)) }, "Couldn't save the schedule");
    setSchedules((p) => p.map((s) => (s.id === id ? next : s)));
    setEditing(null);
  }
  async function toggle(s: BackupSchedule) {
    setBusyId(s.id);
    setError(null);
    try {
      const next = await api<BackupSchedule>(`/schedules/${s.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !s.enabled }) }, "Couldn't change the schedule");
      setSchedules((p) => p.map((x) => (x.id === s.id ? next : x)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  async function runNow(s: BackupSchedule) {
    setBusyId(s.id);
    setError(null);
    try {
      const started = await post<{ operationId: string }>(`/schedules/${s.id}/run`, undefined, "Couldn't start the backup");
      track(started.operationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }
  async function remove(s: BackupSchedule) {
    if (!confirm(`Delete the schedule "${s.name}"? The backups it already made are kept.`)) return;
    setBusyId(s.id);
    setError(null);
    try {
      await api(`/schedules/${s.id}`, { method: "DELETE" }, "Couldn't delete the schedule");
      setSchedules((p) => p.filter((x) => x.id !== s.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const fromSchedule = (s: BackupSchedule): FormState => ({
    name: s.name,
    enabled: s.enabled,
    frequency: s.frequency,
    time: s.time,
    dayOfWeek: s.dayOfWeek,
    dayOfMonth: s.dayOfMonth,
    timezone: s.timezone,
    keep: s.keep,
    includeFiles: s.includeFiles,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          A schedule makes a backup by itself at the times you choose and deletes the oldest ones so storage does not fill up. If a scheduled
          backup fails, the administrators get a notification. You can have several schedules, for example a nightly one that keeps a week and a
          monthly one that keeps a year.
        </p>
        {!creating ? (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3.5 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus aria-hidden className="h-4 w-4" /> New schedule
          </button>
        ) : null}
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {op && op.status === "running" ? <OperationProgress op={op} title="Making a scheduled backup" /> : null}

      {creating ? <ScheduleForm initial={blank()} submitLabel="Create schedule" onSubmit={create} onCancel={() => setCreating(false)} /> : null}

      {schedules.length === 0 && !creating ? (
        <p className="rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">
          No schedules yet. Nothing is backed up automatically.
        </p>
      ) : null}

      <ul className="space-y-3">
        {schedules.map((s) =>
          editing === s.id ? (
            <li key={s.id}>
              <ScheduleForm initial={fromSchedule(s)} submitLabel="Save changes" onSubmit={(v) => update(s.id, v)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={s.id} className={`rounded-md border border-slate-300 p-4 dark:border-slate-800 ${s.enabled ? "" : "opacity-70"}`} data-schedule-id={s.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 font-medium">
                    <CalendarClock aria-hidden className="h-4 w-4 text-brand-600" /> {s.name}
                    {!s.enabled ? <span className="rounded border border-slate-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-500 dark:border-slate-700">Paused</span> : null}
                  </div>
                  <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{describeSchedule(s)}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {s.enabled && s.nextRunAt ? (
                      <>Next: <LocalDateTime value={s.nextRunAt} options={WHEN} /></>
                    ) : (
                      "Not scheduled while paused."
                    )}
                    {s.lastRunAt ? (
                      <>
                        {" "}
                        - Last: <LocalDateTime value={s.lastRunAt} options={WHEN} />{" "}
                        <span className={s.lastStatus === "failed" ? "font-medium text-rose-600 dark:text-rose-400" : "text-emerald-700 dark:text-emerald-400"}>
                          {s.lastStatus === "failed" ? "failed" : "ok"}
                        </span>
                      </>
                    ) : null}
                  </p>
                  {s.lastStatus === "failed" && s.lastError ? <p className="mt-1 max-w-2xl text-xs text-rose-600 dark:text-rose-400">{s.lastError}</p> : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button type="button" onClick={() => void runNow(s)} disabled={busyId === s.id || op?.status === "running"} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    <Play aria-hidden className="h-3.5 w-3.5" /> Run now
                  </button>
                  <button type="button" onClick={() => void toggle(s)} disabled={busyId === s.id} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    {s.enabled ? <Pause aria-hidden className="h-3.5 w-3.5" /> : <Play aria-hidden className="h-3.5 w-3.5" />} {s.enabled ? "Pause" : "Resume"}
                  </button>
                  <button type="button" onClick={() => setEditing(s.id)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900">
                    <Pencil aria-hidden className="h-3.5 w-3.5" /> Edit
                  </button>
                  <button type="button" onClick={() => void remove(s)} disabled={busyId === s.id} className="inline-flex items-center gap-1 rounded-md border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950">
                    <Trash2 aria-hidden className="h-3.5 w-3.5" /> Delete
                  </button>
                </div>
              </div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
