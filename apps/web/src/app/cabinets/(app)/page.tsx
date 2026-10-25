"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { DEFAULT_RACK_UNITS, MAX_RACK_UNITS, type RackListEntry } from "@church/shared";
import { useCanWrite, StatusLine, inputCls, cardCls, Modal, Field } from "@/app/monitoring/network-cisco/cisco-ui";
import { errorText } from "@/lib/use-switch-models";

export default function CabinetsPage() {
  const canWrite = useCanWrite();
  const [racks, setRacks] = useState<RackListEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ name: "", location: "", units: String(DEFAULT_RACK_UNITS) });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/racks", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setRacks((await r.json()) as RackListEntry[]);
      else setStatus({ ok: false, text: await errorText(r) });
    } catch {
      setStatus({ ok: false, text: "The cabinets could not be loaded." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await fetch("/api/racks", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: form.name, location: form.location, units: Number(form.units) }),
      });
      if (!r.ok) {
        setStatus({ ok: false, text: await errorText(r) });
        return;
      }
      const created = (await r.json()) as { id: string };
      window.location.assign(`/cabinets/${created.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Where the switches, hosts and access points sit in each cabinet, with a front and rear view and a printable sheet.
        </p>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> New cabinet
          </button>
        ) : null}
      </div>
      <StatusLine status={status} />

      {racks === null ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : racks.length === 0 ? (
        <p className={`${cardCls} text-sm text-slate-600 dark:text-slate-300`}>
          No cabinets yet.{canWrite ? " Add one, then place your switches and hosts in it." : " A monitoring administrator can add one."}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {racks.map((r) => (
            <li key={r.id}>
              <Link href={`/cabinets/${r.id}`} className={`${cardCls} block hover:bg-slate-50 dark:hover:bg-slate-900`}>
                <span className="block text-base font-semibold">{r.name}</span>
                {r.location ? <span className="block text-xs text-slate-500 dark:text-slate-400">{r.location}</span> : null}
                <span className="mt-3 block text-sm text-slate-600 dark:text-slate-300">
                  {r.itemCount} {r.itemCount === 1 ? "item" : "items"} · {r.usedUnits} of {r.units}U used
                </span>
                <span
                  role="img"
                  aria-label={`${Math.round((r.usedUnits / Math.max(r.units, 1)) * 100)} percent full`}
                  className="mt-2 block h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-800"
                >
                  <span className="block h-full bg-brand-600" style={{ width: `${Math.min(100, (r.usedUnits / Math.max(r.units, 1)) * 100)}%` }} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <Modal title="New cabinet" onClose={() => setAdding(false)}>
          <form onSubmit={create} className="space-y-3 text-sm">
            <Field label="Name *">
              <input required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Server room rack A" className={`w-full ${inputCls}`} />
            </Field>
            <Field label="Location">
              <input maxLength={120} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} placeholder="Basement comms room" className={`w-full ${inputCls}`} />
            </Field>
            <Field label="Height (U)">
              <input type="number" min={1} max={MAX_RACK_UNITS} required value={form.units} onChange={(e) => setForm({ ...form, units: e.target.value })} className={`w-28 ${inputCls}`} />
            </Field>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAdding(false)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
                Create
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
