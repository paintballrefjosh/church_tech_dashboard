"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X, RefreshCw, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { WEEKDAYS, type AssignableUser, type ChecklistService } from "@church/shared";

interface TemplateBrief {
  id: string;
  name: string;
}

interface PositionRow {
  positionName: string;
  include: boolean;
  defaultUserIds: string[];
}

/**
 * Create/edit a recurring service: one or more templates (combined, in order,
 * into each occurrence's task list) + weekly schedule, the stations it needs,
 * and default people per station. Occurrences are generated automatically
 * (and can be forced with "Generate now").
 */
export function ServiceEditor({
  templates,
  users,
  initial,
}: {
  templates: TemplateBrief[];
  users: AssignableUser[];
  initial?: ChecklistService;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [templateIds, setTemplateIds] = useState<string[]>(initial?.templateIds ?? []);
  const [active, setActive] = useState(initial?.active ?? true);
  const [weekday, setWeekday] = useState(initial?.weekday ?? 0);
  const [timeOfDay, setTimeOfDay] = useState(initial?.timeOfDay ?? "09:00");
  const [positions, setPositions] = useState<PositionRow[]>(
    initial?.positions.map((p) => ({
      positionName: p.positionName,
      include: true,
      defaultUserIds: p.defaultUserIds,
    })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Count of still-upcoming events this service made, shown in the delete prompt
  // (null until loaded / if the count fetch fails).
  const [futureCount, setFutureCount] = useState<number | null>(null);

  const userLabel = new Map(users.map((u) => [u.id, u.name || u.email]));
  const templateLabel = new Map(templates.map((t) => [t.id, t.name]));
  const templateIdsKey = templateIds.join(",");

  // When the chosen templates change, pull the union of their stations and
  // merge with any we already have (so an edit keeps its chosen defaults).
  useEffect(() => {
    if (!templateIds.length) {
      setPositions([]);
      return;
    }
    let cancelled = false;
    void fetch(`/api/checklists/template-positions?ids=${templateIds.map(encodeURIComponent).join(",")}`, {
      credentials: "same-origin",
    })
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .then((names) => {
        if (cancelled) return;
        setPositions((cur) => {
          const byName = new Map(cur.map((p) => [p.positionName, p]));
          return names.map(
            (positionName) =>
              byName.get(positionName) ?? { positionName, include: true, defaultUserIds: [] },
          );
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateIdsKey]);

  function toggleTemplate(id: string) {
    setTemplateIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  }

  function moveTemplate(id: string, dir: -1 | 1) {
    setTemplateIds((cur) => {
      const i = cur.indexOf(id);
      const j = i + dir;
      if (i === -1 || j < 0 || j >= cur.length) return cur;
      const next = [...cur];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  function setPos(name: string, patch: Partial<PositionRow>) {
    setPositions((cur) => cur.map((p) => (p.positionName === name ? { ...p, ...patch } : p)));
  }

  async function save() {
    setErr(null);
    if (!name.trim() || templateIds.length === 0) {
      setErr("Name and at least one template are required.");
      return;
    }
    setBusy(true);
    try {
      const body = {
        name,
        description: description || null,
        templateIds,
        active,
        recurrenceKind: "weekly" as const,
        weekday,
        timeOfDay,
        positions: positions
          .filter((p) => p.include)
          .map((p) => ({ positionName: p.positionName, defaultUserIds: p.defaultUserIds })),
      };
      const url = initial ? `/api/checklists/services/${initial.id}` : "/api/checklists/services";
      const r = await fetch(url, {
        method: initial ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Save failed (${r.status})`);
        return;
      }
      router.push("/admin/checklists/services");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function generateNow() {
    if (!initial) return;
    setBusy(true);
    try {
      await fetch(`/api/checklists/services/${initial.id}/generate`, {
        method: "POST",
        credentials: "same-origin",
      });
    } finally {
      setBusy(false);
    }
  }

  /** Open the delete confirmation, loading how many future events would go with it. */
  async function openDeleteConfirm() {
    setConfirmDelete(true);
    setFutureCount(null);
    if (!initial) return;
    try {
      const r = await fetch("/api/checklists/events", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const events = (await r.json()) as { serviceId: string | null; scheduledAt: string | null }[];
        const now = Date.now();
        setFutureCount(
          events.filter(
            (e) => e.serviceId === initial.id && e.scheduledAt && new Date(e.scheduledAt).getTime() >= now,
          ).length,
        );
      }
    } catch {
      /* fall back to a count-less prompt */
    }
  }

  async function remove(deleteFutureEvents: boolean) {
    if (!initial) return;
    setBusy(true);
    try {
      await fetch(`/api/checklists/services/${initial.id}?deleteFutureEvents=${deleteFutureEvents}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      router.push("/admin/checklists/services");
      router.refresh();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const inputCls =
    "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950";

  return (
    <div className="mt-6 space-y-5">
      {err ? (
        <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
          {err}
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-slate-500">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sunday Service" className={inputCls} />
        </label>
        <div className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs font-medium text-slate-500">Templates (task lists)</span>
          {templates.length === 0 ? (
            <p className="text-xs text-slate-500">No templates yet — create one first.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border border-slate-300 p-2.5 dark:border-slate-700">
              {templates.map((t) => (
                <label key={t.id} className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={templateIds.includes(t.id)}
                    onChange={() => toggleTemplate(t.id)}
                    className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
                  />
                  {t.name}
                </label>
              ))}
            </div>
          )}
          {templateIds.length === 0 ? (
            <span className="text-[11px] text-rose-600 dark:text-rose-400">Choose at least one template.</span>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {templateIds.length > 1 ? <span className="text-[11px] text-slate-500">Tasks combine in this order:</span> : null}
              {templateIds.map((id, i) => (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] dark:bg-slate-800"
                >
                  {templateIds.length > 1 ? `${i + 1}. ` : ""}
                  {templateLabel.get(id) ?? "…"}
                  {templateIds.length > 1 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => moveTemplate(id, -1)}
                        disabled={i === 0}
                        aria-label="Move earlier"
                        className="text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                      >
                        <ArrowUp className="h-3 w-3" aria-hidden />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveTemplate(id, 1)}
                        disabled={i === templateIds.length - 1}
                        aria-label="Move later"
                        className="text-slate-400 hover:text-slate-700 disabled:opacity-30 dark:hover:text-slate-200"
                      >
                        <ArrowDown className="h-3 w-3" aria-hidden />
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => toggleTemplate(id)}
                    aria-label="Remove"
                    className="text-slate-400 hover:text-rose-600"
                  >
                    <X className="h-3 w-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-slate-500">Repeats every</span>
          <select value={weekday} onChange={(e) => setWeekday(parseInt(e.target.value, 10))} className={inputCls}>
            {WEEKDAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-slate-500">At</span>
          <input type="time" value={timeOfDay} onChange={(e) => setTimeOfDay(e.target.value)} className={inputCls} />
        </label>
        <label className="flex flex-col gap-1 text-sm sm:col-span-2">
          <span className="text-xs font-medium text-slate-500">Description (optional)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputCls} />
        </label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 rounded border-slate-300 dark:border-slate-700" />
          <span>Active — generate upcoming occurrences automatically</span>
        </label>
      </div>

      <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Stations</legend>
        {positions.length === 0 ? (
          <p className="text-xs text-slate-500">
            {templateIds.length ? "These templates have no positions on their tasks." : "Choose a template to see its stations."}
          </p>
        ) : (
          <ul className="space-y-2">
            {positions.map((p) => {
              const rosteredIds = new Set(p.defaultUserIds);
              const addable = users.filter((u) => !rosteredIds.has(u.id));
              return (
                <li key={p.positionName} className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={p.include}
                      onChange={(e) => setPos(p.positionName, { include: e.target.checked })}
                      className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
                    />
                    {p.positionName}
                  </label>
                  {p.include ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-6">
                      <span className="text-[11px] text-slate-500">Default people:</span>
                      {p.defaultUserIds.length === 0 ? (
                        <span className="text-[11px] text-slate-400">none</span>
                      ) : (
                        p.defaultUserIds.map((uid) => (
                          <span key={uid} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] dark:bg-slate-800">
                            {userLabel.get(uid) ?? "Someone"}
                            <button
                              type="button"
                              onClick={() => setPos(p.positionName, { defaultUserIds: p.defaultUserIds.filter((x) => x !== uid) })}
                              aria-label="Remove"
                              className="text-slate-400 hover:text-rose-600"
                            >
                              <X className="h-3 w-3" aria-hidden />
                            </button>
                          </span>
                        ))
                      )}
                      {addable.length > 0 ? (
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              setPos(p.positionName, { defaultUserIds: [...p.defaultUserIds, e.target.value] });
                          }}
                          className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-950"
                        >
                          <option value="">+ Add default</option>
                          {addable.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name || u.email}
                            </option>
                          ))}
                        </select>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {initial ? "Save changes" : "Create service"}
        </button>
        {initial ? (
          <>
            <button
              type="button"
              onClick={() => void generateNow()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Generate now
            </button>
            <button
              type="button"
              onClick={() => void openDeleteConfirm()}
              disabled={busy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950/40"
            >
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          </>
        ) : null}
      </div>

      {confirmDelete ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
            <h3 className="text-base font-semibold">Delete service</h3>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Also delete{" "}
              {futureCount === null
                ? "all future scheduled events"
                : `${futureCount} future scheduled event${futureCount === 1 ? "" : "s"}`}{" "}
              created by this service? Past events are kept either way.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={busy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50 dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void remove(false)}
                disabled={busy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                No, keep events
              </button>
              <button
                type="button"
                onClick={() => void remove(true)}
                disabled={busy}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
              >
                Yes, delete them
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
