"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { Pencil, Trash2, RefreshCw, Plus } from "lucide-react";
import type { CiscoSwitch } from "@church/shared";
import {
  StatusPill,
  computeStatus,
  fmtTime,
  useCanWrite,
  StatusLine,
  Modal,
  cardCls,
  type SwStatus,
} from "./cisco-ui";
import { EMPTY_SWITCH_FORM, SwitchFormModal, formFromSwitch, type SwitchFormState } from "./switch-form";
import { usePoll } from "@/lib/use-poll";

export default function CiscoDashboardPage() {
  const canWrite = useCanWrite();
  const [switches, setSwitches] = useState<CiscoSwitch[] | null>(null);
  const [form, setForm] = useState<SwitchFormState | null>(null);
  const [confirmDel, setConfirmDel] = useState<CiscoSwitch | null>(null);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/cisco/switches", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setSwitches((await r.json()) as CiscoSwitch[]);
    } catch {
      /* transient */
    }
  }, []);

  usePoll(load, 15_000);

  async function doDelete() {
    if (!confirmDel) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/cisco/switches/${confirmDel.id}`, { method: "DELETE", credentials: "same-origin" });
      setStatus(r.ok ? { ok: true, text: "Switch deleted." } : { ok: false, text: `Delete failed (${r.status})` });
      setConfirmDel(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function poll(sw: CiscoSwitch) {
    setPolling(sw.id);
    try {
      await fetch(`/api/cisco/switches/${sw.id}/poll`, { method: "POST", credentials: "same-origin" });
      setStatus({ ok: true, text: `Polling ${sw.hostname}…` });
      setTimeout(() => void load(), 4000);
    } finally {
      setPolling(null);
    }
  }

  if (!switches) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  const counts: Record<SwStatus, number> = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const s of switches) counts[computeStatus(s)]++;

  const tiles: Array<{ label: string; value: number; tone: string }> = [
    { label: "Total", value: switches.length, tone: "text-slate-900 dark:text-slate-100" },
    { label: "Online", value: counts.green, tone: "text-emerald-700 dark:text-emerald-400" },
    { label: "Port down", value: counts.yellow, tone: "text-amber-700 dark:text-amber-400" },
    { label: "Config drift", value: counts.orange, tone: "text-orange-700 dark:text-orange-400" },
    { label: "Unreachable", value: counts.red, tone: "text-rose-600 dark:text-rose-400" },
  ];

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className={cardCls}>
            <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{t.label}</div>
            <div className={`mt-1 text-2xl font-semibold ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </section>

      <StatusLine status={status} />

      {switches.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No switches yet.{" "}
            {canWrite ? (
              <button type="button" onClick={() => setForm({ ...EMPTY_SWITCH_FORM })} className="text-brand-600 dark:text-brand-400 hover:underline">
                Add one
              </button>
            ) : (
              "Ask an admin to add one"
            )}{" "}
            to start monitoring.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Hostname</th>
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Model</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Uptime</th>
                <th className="px-3 py-2 text-right">Ports</th>
                <th className={`px-3 py-2 ${canWrite ? "text-right" : ""}`}>
                  {canWrite ? (
                    <span className="inline-flex items-center justify-end gap-3">
                      Actions
                      <button
                        type="button"
                        onClick={() => setForm({ ...EMPTY_SWITCH_FORM })}
                        className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1.5 text-xs font-medium normal-case tracking-normal text-white transition hover:bg-brand-700"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Add switch
                      </button>
                    </span>
                  ) : (
                    "Last polled"
                  )}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {switches.map((s) => (
                <tr key={s.id} className="align-middle hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className="px-3 py-2">
                    {computeStatus(s) === "yellow" ? (
                      // "Port down" links straight to the switch's port page.
                      <Link
                        href={`/monitoring/network-cisco/switches/${s.id}`}
                        className="hover:underline"
                      >
                        <StatusPill status={computeStatus(s)} />
                      </Link>
                    ) : computeStatus(s) === "orange" ? (
                      // "Drift" links to the drift log, where each difference can be pushed or accepted.
                      <Link
                        href="/monitoring/network-cisco/drift"
                        title="Open the drift log"
                        className="hover:underline"
                      >
                        <StatusPill status={computeStatus(s)} />
                      </Link>
                    ) : (
                      <StatusPill status={computeStatus(s)} />
                    )}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/monitoring/network-cisco/switches/${s.id}`}
                      className="text-brand-700 hover:underline dark:text-brand-300"
                    >
                      {s.hostname}
                    </Link>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.ipAddress}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{s.model ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{s.location ?? "—"}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{s.uptime ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {/* Whole ports cell links to the port page; spans keep their colours. */}
                    <Link
                      href={`/monitoring/network-cisco/switches/${s.id}`}
                      className="hover:underline"
                    >
                      <span className="text-emerald-700 dark:text-emerald-400">{s.portsUp ?? 0}</span>
                      <span className="text-slate-500 dark:text-slate-400"> / {s.portCount ?? 0}</span>
                      {(s.portsDownEnabled ?? 0) > 0 ? (
                        <span className="ml-1 text-amber-700 dark:text-amber-400">({s.portsDownEnabled} down)</span>
                      ) : null}
                    </Link>
                  </td>
                  {canWrite ? (
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setForm(formFromSwitch(s))}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => void poll(s)}
                          disabled={polling === s.id}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-50 dark:border-slate-700 dark:text-brand-300 dark:hover:bg-brand-900/30"
                        >
                          <RefreshCw className={`h-3.5 w-3.5 ${polling === s.id ? "animate-spin" : ""}`} aria-hidden />
                          {polling === s.id ? "Polling…" : "Poll"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDel(s)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete
                        </button>
                      </div>
                    </td>
                  ) : (
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400">{fmtTime(s.lastPolledAt)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500 dark:text-slate-400">Auto-refreshes every 15s.</p>

      {form ? (
        <SwitchFormModal
          initial={form}
          onClose={() => setForm(null)}
          onSaved={async (text) => {
            setStatus({ ok: true, text });
            setForm(null);
            await load();
          }}
        />
      ) : null}

      {confirmDel ? (
        <Modal title="Delete switch" onClose={() => setConfirmDel(null)}>
          <p className="text-sm">
            Delete <span className="font-medium">{confirmDel.hostname}</span> and all its ports, backups, and drift
            history? This cannot be undone.
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <button type="button" onClick={() => setConfirmDel(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
              Cancel
            </button>
            <button type="button" onClick={() => void doDelete()} disabled={busy} className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-60">
              Delete
            </button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
