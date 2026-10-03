"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, Trash2, Save } from "lucide-react";
import type { ChecklistStation, ChecklistTemplate, ChecklistTemplateTask } from "@church/shared";

export function TemplateEditorClient({
  template,
  initialTasks,
  stations,
}: {
  template: ChecklistTemplate;
  initialTasks: ChecklistTemplateTask[];
  stations: ChecklistStation[];
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [newTitle, setNewTitle] = useState("");
  const [stationId, setStationId] = useState<string>(template.stationId ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function saveStation(next: string) {
    setStationId(next);
    await fetch(`/api/checklists/templates/${template.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stationId: next || null }),
    });
    router.refresh();
  }

  async function addTask() {
    if (!newTitle.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/checklists/templates/${template.id}/tasks`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setErr(b.message ?? `Add failed (${r.status})`);
        return;
      }
      const task = (await r.json()) as ChecklistTemplateTask;
      setTasks((cur) => [...cur, task]);
      setNewTitle("");
    } finally {
      setBusy(false);
    }
  }

  async function saveTask(task: ChecklistTemplateTask) {
    const r = await fetch(`/api/checklists/template-tasks/${task.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: task.title,
        description: task.description,
      }),
    });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Save failed (${r.status})`);
    }
  }

  async function deleteTask(taskId: string) {
    if (!confirm("Delete this task?")) return;
    const r = await fetch(`/api/checklists/template-tasks/${taskId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) {
      setTasks((cur) => cur.filter((t) => t.id !== taskId));
    }
  }

  async function deleteTemplate() {
    if (
      !confirm(
        `Delete template "${template.name}"? Existing events created from it will be left alone.`,
      )
    )
      return;
    const r = await fetch(`/api/checklists/templates/${template.id}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (r.ok) router.push("/admin/checklists");
  }

  return (
    <div className="mt-6 space-y-6">
      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <label className="flex flex-col gap-1 text-sm sm:max-w-sm">
          <span className="text-xs font-medium text-slate-500">Station</span>
          <select
            value={stationId}
            onChange={(e) => void saveStation(e.target.value)}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          >
            <option value="">General (no station)</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-slate-500">
            This whole template is the checklist for that station.{" "}
            {stations.length === 0 ? (
              <a href="/admin/checklists/stations" className="text-brand-600 underline">
                Add stations
              </a>
            ) : null}
          </span>
        </label>
      </section>

      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-sm font-medium">Tasks ({tasks.length})</h2>

        <ul className="mt-3 space-y-2">
          {tasks.map((t, idx) => (
            <li
              key={t.id}
              className="rounded-md border border-slate-300 p-3 dark:border-slate-800"
            >
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  type="text"
                  defaultValue={t.title}
                  onBlur={(e) => {
                    if (e.target.value.trim() !== t.title) {
                      const next = [...tasks];
                      next[idx] = { ...t, title: e.target.value.trim() };
                      setTasks(next);
                      void saveTask(next[idx]);
                    }
                  }}
                  className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  type="button"
                  onClick={() => void deleteTask(t.id)}
                  aria-label="Delete task"
                  className="rounded-md p-1.5 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-900/30"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
              <textarea
                defaultValue={t.description ?? ""}
                placeholder="Optional description…"
                rows={1}
                onBlur={(e) => {
                  const next = e.target.value.trim() || null;
                  if (next !== t.description) {
                    const updated = [...tasks];
                    updated[idx] = { ...t, description: next };
                    setTasks(updated);
                    void saveTask(updated[idx]);
                  }
                }}
                className="mt-2 w-full resize-y rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
            </li>
          ))}
        </ul>

        <div className="mt-3 grid gap-2 rounded-md border border-dashed border-slate-300 p-3 sm:grid-cols-[1fr_auto] dark:border-slate-700">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="New task title…"
            className="rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
          <button
            type="button"
            onClick={() => void addTask()}
            disabled={busy || !newTitle.trim()}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add
          </button>
        </div>
        {err ? <p className="mt-2 text-xs text-rose-600">{err}</p> : null}
      </section>

      <section className="flex items-center justify-between rounded-md border border-rose-200 p-4 text-xs dark:border-rose-900/50">
        <div>
          <div className="text-sm font-medium text-rose-700 dark:text-rose-300">Delete template</div>
          <div className="text-rose-600/80 dark:text-rose-400/80">
            Removes the template (and its task list). Existing events keep working.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void deleteTemplate()}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
        >
          <Trash2 className="h-4 w-4" aria-hidden /> Delete
        </button>
      </section>
    </div>
  );
}
// keep Save import alive — used by future bulk-save action
void Save;
