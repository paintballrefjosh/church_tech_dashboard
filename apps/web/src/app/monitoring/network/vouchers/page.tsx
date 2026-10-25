"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Printer, Ticket, Trash2 } from "lucide-react";
import { describeVoucherMinutes, type UnifiVoucher } from "@church/shared";
import { inputCls, cardCls, Field, useToasts, ToastStack } from "../../network-cisco/cisco-ui";

const LENGTHS = [
  { minutes: 240, label: "4 hours" },
  { minutes: 1440, label: "1 day" },
  { minutes: 4320, label: "3 days" },
  { minutes: 10080, label: "1 week" },
];

function errorText(body: unknown, status: number): string {
  const m = (body as { message?: unknown } | null)?.message as { fieldErrors?: Record<string, string[]> } | string | undefined;
  if (typeof m === "string") return m;
  return Object.values(m?.fieldErrors ?? {})[0]?.[0] ?? `Failed (${status})`;
}

/** Guest Wi-Fi vouchers on the UniFi controller: make a batch for an event, print them as cards, revoke one. */
export default function VouchersPage() {
  const [rows, setRows] = useState<UnifiVoucher[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [count, setCount] = useState(10);
  const [minutes, setMinutes] = useState(1440);
  const [uses, setUses] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { toasts, show, dismiss } = useToasts();

  const load = useCallback(async () => {
    const r = await fetch("/api/v1/unifi/vouchers", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) {
      setRows((await r.json()) as UnifiVoucher[]);
      setProblem(null);
    } else if (r.status === 403) {
      setProblem("Guest vouchers are made by people with the Monitoring admin tier.");
    } else {
      setProblem(errorText(await r.json().catch(() => null), r.status));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      const r = await fetch("/api/v1/unifi/vouchers", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count, minutes, uses, note }),
      });
      const body = (await r.json().catch(() => null)) as unknown;
      if (!r.ok) throw new Error(errorText(body, r.status));
      const made = body as UnifiVoucher[];
      setSelected(new Set(made.map((v) => v.id)));
      show(true, `${made.length} voucher${made.length === 1 ? "" : "s"} made and selected for printing.`);
      await load();
    } catch (err) {
      show(false, (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(v: UnifiVoucher) {
    if (!confirm(`Revoke ${v.code}? A guest using it is disconnected when it ends.`)) return;
    const r = await fetch(`/api/v1/unifi/vouchers/${v.id}`, { method: "DELETE", credentials: "same-origin" });
    if (!r.ok) show(false, `Failed (${r.status})`);
    await load();
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Ticket className="h-5 w-5" aria-hidden /> Guest Wi-Fi vouchers
        </h2>
        <Link href="/monitoring/network" className="text-sm text-brand-600 hover:underline dark:text-brand-400">
          Back to the network
        </Link>
      </div>
      <p className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        Codes for the guest network, for a conference, a retreat or visiting speakers. The controller&apos;s guest portal must use voucher
        sign-in. A voucher&apos;s time starts when it is first used.
      </p>

      {problem ? <p className={`${cardCls} text-sm text-rose-700 dark:text-rose-300`}>{problem}</p> : null}

      {!problem ? (
        <div className={`${cardCls} grid gap-3 sm:grid-cols-5 sm:items-end`}>
          <Field label="How many">
            <input type="number" min={1} max={100} className={`${inputCls} w-full`} value={count} onChange={(e) => setCount(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Each lasts">
            <select className={`${inputCls} w-full`} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
              {LENGTHS.map((l) => (
                <option key={l.minutes} value={l.minutes}>
                  {l.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Devices per code">
            <select className={`${inputCls} w-full`} value={uses} onChange={(e) => setUses(Number(e.target.value))}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={0}>Any number</option>
            </select>
          </Field>
          <Field label="Note (printed small)">
            <input className={`${inputCls} w-full`} maxLength={100} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Youth retreat" />
          </Field>
          <button
            type="button"
            disabled={busy}
            onClick={() => void create()}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? "Making…" : "Make vouchers"}
          </button>
        </div>
      ) : null}

      {rows && rows.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span>{selected.size} selected</span>
            <button type="button" onClick={() => setSelected(new Set(rows.map((v) => v.id)))} className="text-brand-600 hover:underline dark:text-brand-400">
              Select all
            </button>
            <button type="button" onClick={() => setSelected(new Set())} className="text-brand-600 hover:underline dark:text-brand-400">
              Clear
            </button>
            <a
              href={selected.size ? `/print/vouchers?ids=${[...selected].join(",")}` : undefined}
              target="_blank"
              rel="noopener"
              aria-disabled={selected.size === 0}
              className={`ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 dark:border-slate-700 ${selected.size ? "" : "pointer-events-none opacity-60"}`}
            >
              <Printer className="h-4 w-4" aria-hidden /> Print the selected
            </a>
          </div>
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800" tabIndex={0} role="region" aria-label="Vouchers">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">
                    <span className="sr-only">Selected</span>
                  </th>
                  <th className="px-3 py-2">Code</th>
                  <th className="px-3 py-2">Lasts</th>
                  <th className="px-3 py-2">Used</th>
                  <th className="px-3 py-2">Note</th>
                  <th className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {rows.map((v) => (
                  <tr key={v.id}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} aria-label={`Select ${v.code}`} />
                    </td>
                    <td className="px-3 py-2 font-mono">{v.code}</td>
                    <td className="px-3 py-2">{describeVoucherMinutes(v.minutes)}</td>
                    <td className="px-3 py-2">
                      {v.used}
                      {v.uses ? ` of ${v.uses}` : ""}
                    </td>
                    <td className="px-3 py-2">{v.note}</td>
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => void revoke(v)} className="rounded-md p-1.5 text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-950" aria-label={`Revoke ${v.code}`}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : rows ? (
        <p className={`${cardCls} text-sm text-slate-600 dark:text-slate-400`}>No vouchers yet.</p>
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
