"use client";

import { useState } from "react";
import { Plus, Trash2, MonitorSpeaker } from "lucide-react";
import type { ChecklistStation } from "@church/shared";

/**
 * Manage the first-class list of stations (Camera, FOH, ProPresenter, Lights,
 * Stream, …). A template is assigned to one of these; a day's event then groups
 * by station. `pcAlias` optionally maps a station to a Planning Center team
 * position for auto-assign.
 */
export function StationsAdminClient({ initial }: { initial: ChecklistStation[] }) {
  const [stations, setStations] = useState(initial);
  const [name, setName] = useState("");
  const [pcAlias, setPcAlias] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    const r = await fetch("/api/checklists/stations", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setStations((await r.json()) as ChecklistStation[]);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/checklists/stations", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), pcAlias: pcAlias.trim() || null }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        setErr(Array.isArray(b.message) ? b.message.join(", ") : (b.message ?? `failed (${r.status})`));
        return;
      }
      setName("");
      setPcAlias("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function patch(s: ChecklistStation, body: Record<string, unknown>) {
    const r = await fetch(`/api/checklists/stations/${s.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      const updated = (await r.json()) as ChecklistStation;
      setStations((prev) => prev.map((x) => (x.id === s.id ? updated : x)));
    } else {
      const b = (await r.json().catch(() => ({}))) as { message?: string };
      setErr(b.message ?? `Save failed (${r.status})`);
    }
  }

  async function destroy(s: ChecklistStation) {
    if (!confirm(`Delete station "${s.name}"? Templates using it become "General"; existing events keep their names.`)) return;
    const r = await fetch(`/api/checklists/stations/${s.id}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) setStations((prev) => prev.filter((x) => x.id !== s.id));
    else setErr(`Delete failed (${r.status})`);
  }

  return (
    <div className="mt-6 space-y-6">
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2 rounded-md border border-slate-300 p-4 dark:border-slate-800"
      >
        <label className="flex flex-col text-xs">
          <span className="text-slate-500">Station name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Camera, FOH, ProPresenter…"
            maxLength={120}
            required
            className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <label className="flex flex-col text-xs">
          <span className="text-slate-500">Planning Center position (optional)</span>
          <input
            value={pcAlias}
            onChange={(e) => setPcAlias(e.target.value)}
            placeholder="e.g. Camera Operator"
            maxLength={120}
            className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Plus className="h-4 w-4" aria-hidden /> Add station
        </button>
        {err ? <span className="text-xs text-rose-600">{err}</span> : null}
      </form>

      {stations.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
          No stations yet. Add Camera, FOH, ProPresenter, Lights, Stream…
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
          {stations.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <MonitorSpeaker className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
              <input
                defaultValue={s.name}
                maxLength={120}
                aria-label={`Rename ${s.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== s.name) void patch(s, { name: v });
                }}
                className="min-w-[10rem] flex-1 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-sm hover:border-slate-300 focus:border-slate-400 focus:outline-none dark:hover:border-slate-700 dark:focus:border-slate-600"
              />
              <input
                defaultValue={s.pcAlias ?? ""}
                placeholder="PC position…"
                maxLength={120}
                aria-label={`Planning Center alias for ${s.name}`}
                onBlur={(e) => {
                  const v = e.target.value.trim() || null;
                  if (v !== s.pcAlias) void patch(s, { pcAlias: v });
                }}
                className="w-44 rounded border border-slate-300 px-1.5 py-0.5 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <button
                type="button"
                onClick={() => void destroy(s)}
                aria-label={`Delete ${s.name}`}
                className="text-rose-600 hover:text-rose-700"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
