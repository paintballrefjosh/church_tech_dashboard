"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Pencil, Trash2, RefreshCw } from "lucide-react";
import { type CiscoSwitch, type CiscoAlertPrefs, CISCO_ALERT_CATEGORIES } from "@church/shared";
import {
  StatusPill,
  computeStatus,
  fmtTime,
  useCanWrite,
  StatusLine,
  Modal,
  Field,
  inputCls,
  cardCls,
  type SwStatus,
} from "./cisco-ui";
import { CISCO_ADD_SWITCH_EVENT, CISCO_ADD_SWITCH_FLAG } from "./cisco-tabs";

const NO_ALERTS: CiscoAlertPrefs = {
  deviceOffline: false,
  portStateChange: false,
  configChange: false,
  uptimeChange: false,
};

interface FormState {
  id: string | null;
  hostname: string;
  ipAddress: string;
  username: string;
  password: string;
  model: string;
  location: string;
  checkPortState: boolean;
  alertPrefs: CiscoAlertPrefs;
}
const EMPTY: FormState = {
  id: null,
  hostname: "",
  ipAddress: "",
  username: "admin",
  password: "",
  model: "",
  location: "",
  checkPortState: true,
  alertPrefs: { ...NO_ALERTS },
};

export default function CiscoDashboardPage() {
  const canWrite = useCanWrite();
  const [switches, setSwitches] = useState<CiscoSwitch[] | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
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

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const openAdd = () => setForm({ ...EMPTY });
    try {
      if (sessionStorage.getItem(CISCO_ADD_SWITCH_FLAG)) {
        sessionStorage.removeItem(CISCO_ADD_SWITCH_FLAG);
        openAdd();
      }
    } catch {
      /* private mode */
    }
    window.addEventListener(CISCO_ADD_SWITCH_EVENT, openAdd);
    return () => window.removeEventListener(CISCO_ADD_SWITCH_EVENT, openAdd);
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setStatus(null);
    try {
      const editing = Boolean(form.id);
      const body: Record<string, unknown> = {
        hostname: form.hostname.trim(),
        ipAddress: form.ipAddress.trim(),
        username: form.username.trim(),
        model: form.model.trim() || undefined,
        location: form.location.trim() || undefined,
        checkPortState: form.checkPortState,
        alertPrefs: form.alertPrefs,
      };
      if (form.password) body.password = form.password;
      const r = await fetch(editing ? `/api/cisco/switches/${form.id}` : "/api/cisco/switches", {
        method: editing ? "PATCH" : "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string; error?: string };
        setStatus({ ok: false, text: b.message ?? b.error ?? `Failed (${r.status})` });
        return;
      }
      setStatus({
        ok: true,
        text: editing ? "Switch saved." : "Switch added — polling + importing ports in the background.",
      });
      setForm(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

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

  if (!switches) return <p className="text-sm text-slate-500">Loading…</p>;

  const counts: Record<SwStatus, number> = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const s of switches) counts[computeStatus(s)]++;

  const tiles: Array<{ label: string; value: number; tone: string }> = [
    { label: "Total", value: switches.length, tone: "text-slate-900 dark:text-slate-100" },
    { label: "Online", value: counts.green, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Port down", value: counts.yellow, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Config drift", value: counts.orange, tone: "text-orange-600 dark:text-orange-400" },
    { label: "Unreachable", value: counts.red, tone: "text-rose-600 dark:text-rose-400" },
  ];

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className={cardCls}>
            <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
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
              <button type="button" onClick={() => setForm({ ...EMPTY })} className="text-brand-600 hover:underline">
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
                <th className="px-3 py-2">{canWrite ? "Actions" : "Last polled"}</th>
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
                  <td className="px-3 py-2 text-xs text-slate-500">{s.uptime ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    {/* Whole ports cell links to the port page; spans keep their colours. */}
                    <Link
                      href={`/monitoring/network-cisco/switches/${s.id}`}
                      className="hover:underline"
                    >
                      <span className="text-emerald-600 dark:text-emerald-400">{s.portsUp ?? 0}</span>
                      <span className="text-slate-400"> / {s.portCount ?? 0}</span>
                      {(s.portsDownEnabled ?? 0) > 0 ? (
                        <span className="ml-1 text-amber-600 dark:text-amber-400">({s.portsDownEnabled} down)</span>
                      ) : null}
                    </Link>
                  </td>
                  {canWrite ? (
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setForm({
                              id: s.id,
                              hostname: s.hostname,
                              ipAddress: s.ipAddress,
                              username: s.username,
                              password: "",
                              model: s.model ?? "",
                              location: s.location ?? "",
                              checkPortState: s.checkPortState,
                              alertPrefs: { ...NO_ALERTS, ...s.alertPrefs },
                            })
                          }
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
                    <td className="px-3 py-2 text-xs text-slate-500">{fmtTime(s.lastPolledAt)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-400">Auto-refreshes every 15s.</p>

      {form ? (
        <Modal title={form.id ? "Edit switch" : "Add switch"} onClose={() => setForm(null)}>
          <form onSubmit={save} className="space-y-3 text-sm">
            {!form.id ? (
              <p className="rounded-md border border-brand-300 bg-brand-50 px-3 py-2 text-xs text-brand-800 dark:border-brand-700 dark:bg-brand-900/30 dark:text-brand-200">
                The switch is polled immediately on save and all interfaces imported as the baseline config.
              </p>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hostname *">
                <input required value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
              <Field label="IP address *">
                <input required value={form.ipAddress} onChange={(e) => setForm({ ...form, ipAddress: e.target.value })} className={`w-full font-mono text-xs ${inputCls}`} />
              </Field>
              <Field label="Username">
                <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={`w-full font-mono text-xs ${inputCls}`} />
              </Field>
              <Field label={form.id ? "Password (leave blank to keep)" : "Password"}>
                <input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
              <Field label="Model (auto-detected)">
                <input value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="auto-detected" className={`w-full ${inputCls}`} />
              </Field>
              <Field label="Location">
                <input value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} className={`w-full ${inputCls}`} />
              </Field>
            </div>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={form.checkPortState} onChange={(e) => setForm({ ...form, checkPortState: e.target.checked })} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700" />
              <span>Port state monitoring</span>
            </label>

            <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Alerts</legend>
              <p className="text-xs text-slate-500">
                Notify monitoring admins (in-app + email) when this switch changes state.
              </p>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CISCO_ALERT_CATEGORIES.map((c) => {
                  // Port-state-change alerts only fire when port-state monitoring
                  // is on (see cisco.poller evaluateAlerts), so grey the toggle out
                  // when the master switch is off to reflect that it has no effect.
                  const disabled = c.key === "portStateChange" && !form.checkPortState;
                  return (
                    <label key={c.key} className={`flex items-start gap-2 ${disabled ? "opacity-50" : ""}`}>
                      <input
                        type="checkbox"
                        checked={form.alertPrefs[c.key]}
                        disabled={disabled}
                        onChange={(e) => setForm({ ...form, alertPrefs: { ...form.alertPrefs, [c.key]: e.target.checked } })}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 disabled:cursor-not-allowed dark:border-slate-700"
                      />
                      <span>
                        <span className="block text-sm">{c.label}</span>
                        <span className="block text-[11px] text-slate-500 dark:text-slate-400">
                          {disabled ? "Requires port state monitoring (above)." : c.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setForm(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
                {form.id ? "Save changes" : "Add & import"}
              </button>
            </div>
          </form>
        </Modal>
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
