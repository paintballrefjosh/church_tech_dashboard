"use client";

import { useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import type { ChecklistEventTask } from "@church/shared";

/**
 * Touch-friendly single-station checklist for the tablet at that station. Large
 * tap targets; whoever is authorised for the station (rostered, or a kiosk/admin
 * account) works straight down the list. Completion is gated server-side.
 */
export function StationClient({
  eventId,
  initialTasks,
  canComplete,
  myUserId,
}: {
  eventId: string;
  initialTasks: ChecklistEventTask[];
  canComplete: boolean;
  myUserId: string;
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [err, setErr] = useState<string | null>(null);
  const total = tasks.length;
  const done = tasks.filter((t) => t.completedAt).length;
  const pct = total > 0 ? Math.round((100 * done) / total) : 0;

  async function toggle(taskId: string, completed: boolean) {
    if (!canComplete) return;
    setErr(null);
    const prev = tasks;
    setTasks((cur) =>
      cur.map((t) =>
        t.id === taskId
          ? { ...t, completedAt: completed ? new Date().toISOString() : null, completedByUserId: completed ? myUserId : null }
          : t,
      ),
    );
    const r = await fetch(`/api/checklists/event-tasks/${taskId}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed }),
    });
    if (!r.ok) {
      setTasks(prev);
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Request failed (${r.status})`);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <span className="text-sm font-semibold tabular-nums">
          {done} / {total}
        </span>
      </div>

      {err ? (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      {!canComplete ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-200">
          You&apos;re viewing this station read-only — you aren&apos;t assigned to it.
        </p>
      ) : null}

      <ul className="space-y-3">
        {tasks.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              onClick={() => void toggle(t.id, !t.completedAt)}
              disabled={!canComplete}
              className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition ${
                t.completedAt
                  ? "border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40"
                  : "border-slate-300 bg-white hover:border-brand-400 dark:border-slate-700 dark:bg-slate-900"
              } ${canComplete ? "" : "cursor-default opacity-70"}`}
            >
              {t.completedAt ? (
                <CheckCircle2 className="mt-0.5 h-8 w-8 shrink-0 text-emerald-500" aria-hidden />
              ) : (
                <Circle className="mt-0.5 h-8 w-8 shrink-0 text-slate-300 dark:text-slate-600" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className={`block text-lg font-medium ${t.completedAt ? "text-slate-400 line-through" : ""}`}>
                  {t.title}
                </span>
                {t.description ? (
                  <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">{t.description}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
