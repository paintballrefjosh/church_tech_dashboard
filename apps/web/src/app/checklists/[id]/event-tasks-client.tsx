"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, User as UserIcon, RotateCw, Trash2, X, ExternalLink } from "lucide-react";
import type { AssignableUser, ChecklistEventTask, EventAssignee, PlanDiff } from "@church/shared";

/** Station key for a task — mirrors the server's posKey (null → "Other"). */
function posKeyOf(positionName: string | null): string {
  return positionName && positionName.trim() ? positionName : "Other";
}

/**
 * Client for the event detail page. Tasks are grouped by station (position).
 * Admins manage each station's roster (many people) and can reconcile with a
 * Planning Center plan via a per-position conflict chooser. Anyone rostered to a
 * station — or a kiosk/admin account — can tick that station's tasks.
 */
export function EventTasksClient({
  eventId,
  initialTasks,
  initialRoster,
  myUserId,
  isAdmin,
  canCompleteAny,
  assignableUsers,
  hasPcPlan,
}: {
  eventId: string;
  initialTasks: ChecklistEventTask[];
  initialRoster: EventAssignee[];
  myUserId: string;
  isAdmin: boolean;
  canCompleteAny: boolean;
  assignableUsers: AssignableUser[];
  hasPcPlan: boolean;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [roster, setRoster] = useState(initialRoster);
  const [err, setErr] = useState<string | null>(null);
  const [diff, setDiff] = useState<PlanDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const userLabel = new Map(assignableUsers.map((u) => [u.id, u.name || u.email]));
  const label = (id: string) => userLabel.get(id) ?? "Someone";

  // Stations come from the tasks (their positions); roster + tasks share the key.
  const positions = [...new Set(tasks.map((t) => posKeyOf(t.positionName)))].sort();
  const rosterFor = (pos: string) => roster.filter((a) => a.positionName === pos);
  const canTick = (pos: string) =>
    isAdmin || canCompleteAny || roster.some((a) => a.positionName === pos && a.userId === myUserId);

  const total = tasks.length;
  const completed = tasks.filter((t) => t.completedAt).length;
  const pct = total > 0 ? Math.round((100 * completed) / total) : 0;

  async function refetch() {
    const r = await fetch(`/api/checklists/events/${eventId}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) {
      const b = (await r.json()) as { tasks: ChecklistEventTask[]; roster: EventAssignee[] };
      setTasks(b.tasks);
      setRoster(b.roster ?? []);
    }
  }

  async function setComplete(taskId: string, completed: boolean) {
    setErr(null);
    const prev = tasks;
    setTasks((cur) =>
      cur.map((t) =>
        t.id === taskId
          ? {
              ...t,
              completedAt: completed ? new Date().toISOString() : null,
              completedByUserId: completed ? myUserId : null,
            }
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

  async function addAssignee(positionName: string, userId: string) {
    setErr(null);
    const r = await fetch(`/api/checklists/events/${eventId}/assignees`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ positionName, userId }),
    });
    if (r.ok) setRoster((await r.json()) as EventAssignee[]);
    else {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Add failed (${r.status})`);
    }
  }

  async function removeAssignee(assigneeId: string) {
    setErr(null);
    const prev = roster;
    setRoster((cur) => cur.filter((a) => a.id !== assigneeId));
    const r = await fetch(`/api/checklists/events/${eventId}/assignees/${assigneeId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) setRoster((await r.json()) as EventAssignee[]);
    else setRoster(prev);
  }

  async function openSync() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/checklists/events/${eventId}/plan-diff`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Could not load plan (${r.status})`);
        return;
      }
      setDiff((await r.json()) as PlanDiff);
    } finally {
      setBusy(false);
    }
  }

  async function deleteEvent() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/checklists/events/${eventId}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (r.ok) {
        router.push("/checklists");
        router.refresh();
        return;
      }
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Delete failed (${r.status})`);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function applySync(choices: { positionName: string; use: "plan" | "current" }[]) {
    setBusy(true);
    try {
      const r = await fetch(`/api/checklists/events/${eventId}/apply-plan`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ positions: choices }),
      });
      if (r.ok) {
        setRoster((await r.json()) as EventAssignee[]);
        setDiff(null);
      } else {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Apply failed (${r.status})`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-4">
      <section className="flex items-center gap-3 rounded-md border border-slate-300 p-3 text-sm dark:border-slate-800">
        <div className="flex-1">
          <div className="text-xs uppercase tracking-wide text-slate-500">Progress</div>
          <div className="mt-1 text-base font-semibold">
            {completed} / {total} tasks
          </div>
        </div>
        <div className="w-32">
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className="h-full bg-emerald-500 transition-all"
              style={{ width: `${pct}%` }}
              aria-label={`${pct}% complete`}
            />
          </div>
          <div className="mt-1 text-right text-[10px] text-slate-500">{pct}%</div>
        </div>
        {isAdmin && hasPcPlan ? (
          <button
            type="button"
            onClick={() => void openSync()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <RotateCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} aria-hidden />
            Sync from Plan
          </button>
        ) : null}
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete event
          </button>
        ) : null}
      </section>

      {err ? (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      {positions.map((pos) => {
        const stationTasks = tasks.filter((t) => posKeyOf(t.positionName) === pos);
        const mine = rosterFor(pos);
        const rosteredIds = new Set(mine.map((a) => a.userId));
        const addable = assignableUsers.filter((u) => !rosteredIds.has(u.id));
        // The template(s) feeding this station, for the "children" label.
        const templateNames = [...new Set(stationTasks.map((t) => t.templateName).filter(Boolean))];
        return (
          <section key={pos} className="rounded-md border border-slate-300 dark:border-slate-800">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{pos}</h2>
              {templateNames.length > 0 ? (
                <span className="text-[11px] text-slate-400 dark:text-slate-500">
                  {templateNames.join(" · ")}
                </span>
              ) : null}
              <Link
                href={`/checklists/${eventId}/station/${encodeURIComponent(pos)}`}
                className="inline-flex items-center gap-1 text-[11px] text-brand-600 hover:underline"
              >
                <ExternalLink className="h-3 w-3" aria-hidden /> Open station
              </Link>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {mine.length === 0 ? (
                  <span className="text-[11px] text-slate-400">No one assigned</span>
                ) : (
                  mine.map((a) => (
                    <span
                      key={a.id}
                      className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] dark:bg-slate-800"
                    >
                      <UserIcon className="h-3 w-3 text-slate-400" aria-hidden />
                      {a.userId === myUserId ? "You" : label(a.userId)}
                      {isAdmin ? (
                        <button
                          type="button"
                          onClick={() => void removeAssignee(a.id)}
                          aria-label={`Remove ${label(a.userId)}`}
                          className="rounded-full text-slate-400 hover:text-rose-600"
                        >
                          <X className="h-3 w-3" aria-hidden />
                        </button>
                      ) : null}
                    </span>
                  ))
                )}
                {isAdmin && addable.length > 0 ? (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) void addAssignee(pos, e.target.value);
                    }}
                    aria-label={`Add a person to ${pos}`}
                    className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">+ Add person</option>
                    {addable.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            </div>
            <ul className="divide-y divide-slate-200 dark:divide-slate-800">
              {stationTasks.map((t) => {
                const tickable = canTick(pos);
                return (
                  <li key={t.id} className="p-3">
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => tickable && void setComplete(t.id, !t.completedAt)}
                        disabled={!tickable}
                        aria-label={t.completedAt ? "Mark incomplete" : "Mark complete"}
                        className={`mt-0.5 shrink-0 ${tickable ? "cursor-pointer" : "cursor-not-allowed opacity-50"}`}
                      >
                        {t.completedAt ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" aria-hidden />
                        ) : (
                          <Circle className="h-5 w-5 text-slate-400" aria-hidden />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-medium ${t.completedAt ? "text-slate-400 line-through" : ""}`}>
                          {t.title}
                        </div>
                        {t.description ? (
                          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t.description}</div>
                        ) : null}
                        {t.completedAt ? (
                          <div className="mt-1 text-[11px] text-slate-500">
                            ✓{" "}
                            {new Date(t.completedAt).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}

      {diff ? <SyncDialog diff={diff} busy={busy} onCancel={() => setDiff(null)} onApply={applySync} /> : null}

      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-base font-semibold">Delete event</h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Delete this event, its tasks, and its roster? This cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void deleteEvent()}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Per-position conflict chooser for Sync from Plan. */
function SyncDialog({
  diff,
  busy,
  onCancel,
  onApply,
}: {
  diff: PlanDiff;
  busy: boolean;
  onCancel: () => void;
  onApply: (choices: { positionName: string; use: "plan" | "current" }[]) => void;
}) {
  // Default every position to "current" so nothing is overwritten unless chosen.
  const [choice, setChoice] = useState<Record<string, "plan" | "current">>({});
  const names = (list: AssignableUser[]) =>
    list.length ? list.map((u) => u.name || u.email).join(", ") : "—";
  const conflicts = diff.positions.filter((p) => p.differs);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <h3 className="text-base font-semibold">Sync from Planning Center</h3>
        {!diff.reachable ? (
          <p className="mt-2 text-sm text-rose-600">{diff.error ?? "Planning Center is unreachable."}</p>
        ) : conflicts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">The roster already matches the plan. Nothing to change.</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              These stations differ from the plan. Pick which roster to keep for each.
            </p>
            <ul className="mt-3 space-y-3">
              {conflicts.map((p) => {
                const use = choice[p.positionName] ?? "current";
                return (
                  <li key={p.positionName} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {p.positionName}
                    </div>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {(["current", "plan"] as const).map((side) => (
                        <label
                          key={side}
                          className={`flex cursor-pointer gap-2 rounded-md border p-2 text-xs ${
                            use === side
                              ? "border-brand-500 bg-brand-50 dark:bg-brand-950/40"
                              : "border-slate-200 dark:border-slate-700"
                          }`}
                        >
                          <input
                            type="radio"
                            name={`pos-${p.positionName}`}
                            checked={use === side}
                            onChange={() => setChoice((c) => ({ ...c, [p.positionName]: side }))}
                            className="mt-0.5"
                          />
                          <span>
                            <span className="block font-medium capitalize">
                              {side === "current" ? "Keep current" : "Use plan"}
                            </span>
                            <span className="block text-slate-500">
                              {names(side === "current" ? p.current : p.planned)}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
          >
            Close
          </button>
          {diff.reachable && conflicts.length > 0 ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onApply(conflicts.map((p) => ({ positionName: p.positionName, use: choice[p.positionName] ?? "current" })))
              }
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              Apply choices
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
