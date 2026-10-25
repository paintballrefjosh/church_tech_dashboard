"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  RENEWAL_CATEGORIES,
  RENEWAL_CATEGORY_LABELS,
  daysUntil,
  renewalState,
  type Renewal,
  type RenewalCategory,
  type RenewalState,
} from "@church/shared";
import { useCanWrite, inputCls, cardCls, Modal, Field, useToasts, ToastStack } from "../monitoring/network-cisco/cisco-ui";

const STATE_CLS: Record<RenewalState, string> = {
  overdue: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  today: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  soon: "bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  later: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

/** Today's date on this browser's calendar (the server reminds on the site's; a day's difference at midnight is fine). */
function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function when(r: Renewal, today: string): string {
  const left = daysUntil(r.renewsOn, today);
  if (left < 0) return `Lapsed ${-left} day${left === -1 ? "" : "s"} ago`;
  if (left === 0) return "Today";
  return `In ${left} day${left === 1 ? "" : "s"}`;
}

interface FormState {
  id: string | null;
  name: string;
  category: RenewalCategory;
  vendor: string;
  renewsOn: string;
  cost: string;
  autoRenew: boolean;
  ownerUserId: string | null;
  notes: string;
  remindDays: string;
}

const EMPTY: FormState = { id: null, name: "", category: "licence", vendor: "", renewsOn: "", cost: "", autoRenew: false, ownerUserId: null, notes: "", remindDays: "30, 7" };

function errorText(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message as { fieldErrors?: Record<string, string[]>; formErrors?: string[] } | string | undefined;
  if (typeof m === "string") return m;
  const first = Object.values(m?.fieldErrors ?? {})[0]?.[0] ?? m?.formErrors?.[0];
  return first ?? `Failed (${status})`;
}

export default function RenewalsPage() {
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<Renewal[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [me, setMe] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  const today = localToday();

  const load = useCallback(async () => {
    const r = await fetch("/api/renewals", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setRows((await r.json()) as Renewal[]);
  }, []);

  useEffect(() => {
    void load();
    fetch("/api/me", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((u: { id: string; name: string | null; email: string } | null) => u && setMe({ id: u.id, name: u.name ?? u.email }))
      .catch(() => undefined);
  }, [load]);

  const total = useMemo(() => (rows ?? []).reduce((sum, r) => sum + (r.cost ?? 0), 0), [rows]);

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const remindDays = form.remindDays
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n));
      const body = {
        name: form.name,
        category: form.category,
        vendor: form.vendor,
        renewsOn: form.renewsOn,
        cost: form.cost.trim() === "" ? null : Number(form.cost),
        autoRenew: form.autoRenew,
        ownerUserId: form.ownerUserId,
        notes: form.notes,
        remindDays,
      };
      const r = await fetch(form.id ? `/api/renewals/${form.id}` : "/api/renewals", {
        method: form.id ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(errorText(await r.json().catch(() => null), r.status));
      show(true, "Saved.");
      setForm(null);
      await load();
    } catch (err) {
      show(false, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Renewal) {
    if (!confirm(`Remove "${r.name}"? Its reminders stop.`)) return;
    const res = await fetch(`/api/renewals/${r.id}`, { method: "DELETE", credentials: "same-origin" });
    if (!res.ok) show(false, `Failed (${res.status})`);
    await load();
  }

  if (forbidden) return <p className="text-sm text-slate-600 dark:text-slate-400">Renewals are part of Monitoring, which your account does not have.</p>;
  if (!rows) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Licences, domains, warranties and subscriptions that lapse on a date. The owner (or the admin group) is reminded the chosen
          number of days before, and once if the date passes.
        </p>
        {canWrite ? (
          <button
            type="button"
            onClick={() => setForm({ ...EMPTY })}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> Add a renewal
          </button>
        ) : null}
      </div>

      {rows.length === 0 ? (
        <p className={`${cardCls} text-sm text-slate-600 dark:text-slate-400`}>Nothing recorded yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Renewals">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">What</th>
                <th className="px-3 py-2">Renews</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2 text-right">Cost</th>
                <th className="px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {rows.map((r) => {
                const state = renewalState(r, today);
                return (
                  <tr key={r.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {RENEWAL_CATEGORY_LABELS[r.category]}
                        {r.vendor ? ` · ${r.vendor}` : ""}
                        {r.autoRenew ? " · renews automatically" : ""}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <div>{r.renewsOn}</div>
                      <span className={`mt-0.5 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${STATE_CLS[state]}`}>{when(r, today)}</span>
                    </td>
                    <td className="px-3 py-2">{r.ownerName ?? <span className="text-slate-500 dark:text-slate-400">Admin group</span>}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{r.cost === null ? "—" : r.cost.toFixed(2)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      {canWrite ? (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setForm({
                                id: r.id,
                                name: r.name,
                                category: r.category,
                                vendor: r.vendor,
                                renewsOn: r.renewsOn,
                                cost: r.cost === null ? "" : String(r.cost),
                                autoRenew: r.autoRenew,
                                ownerUserId: r.ownerUserId,
                                notes: r.notes,
                                remindDays: r.remindDays.join(", "),
                              })
                            }
                            className="rounded-md p-1.5 hover:bg-slate-100 dark:hover:bg-slate-800"
                            aria-label={`Edit ${r.name}`}
                          >
                            <Pencil className="h-4 w-4" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => void remove(r)}
                            className="rounded-md p-1.5 text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950"
                            aria-label={`Remove ${r.name}`}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-300 dark:border-slate-700">
                <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400" colSpan={3}>
                  Total of the costs entered
                </td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{total.toFixed(2)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {form ? (
        <Modal title={form.id ? `Edit ${form.name}` : "Add a renewal"} onClose={() => setForm(null)}>
          <div className="space-y-3">
            <Field label="Name">
              <input className={`${inputCls} w-full`} value={form.name} maxLength={200} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="CCLI Streaming Licence" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Kind">
                <select className={`${inputCls} w-full`} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as RenewalCategory })}>
                  {RENEWAL_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {RENEWAL_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="From (vendor)">
                <input className={`${inputCls} w-full`} value={form.vendor} maxLength={200} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
              </Field>
              <Field label="Renews on">
                <input type="date" className={`${inputCls} w-full`} value={form.renewsOn} onChange={(e) => setForm({ ...form, renewsOn: e.target.value })} />
              </Field>
              <Field label="Cost (optional)">
                <input inputMode="decimal" className={`${inputCls} w-full`} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
              </Field>
            </div>
            <Field label="Who is reminded">
              <select
                className={`${inputCls} w-full`}
                value={form.ownerUserId ?? ""}
                onChange={(e) => setForm({ ...form, ownerUserId: e.target.value || null })}
              >
                <option value="">The admin group</option>
                {me ? <option value={me.id}>Me ({me.name})</option> : null}
                {form.ownerUserId && form.ownerUserId !== me?.id ? (
                  <option value={form.ownerUserId}>{rows.find((x) => x.id === form.id)?.ownerName ?? "The current owner"}</option>
                ) : null}
              </select>
            </Field>
            <Field label="Remind this many days before (comma separated)">
              <input className={`${inputCls} w-full`} value={form.remindDays} onChange={(e) => setForm({ ...form, remindDays: e.target.value })} />
            </Field>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.autoRenew} onChange={(e) => setForm({ ...form, autoRenew: e.target.checked })} />
              Renews automatically (the reminder then says to check the card and that it is still wanted)
            </label>
            <Field label="Notes">
              <textarea className={`${inputCls} w-full`} rows={3} value={form.notes} maxLength={4000} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Account number, who to call, where the invoice goes" />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy || !form.name.trim() || !form.renewsOn}
                onClick={() => void save()}
                className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
