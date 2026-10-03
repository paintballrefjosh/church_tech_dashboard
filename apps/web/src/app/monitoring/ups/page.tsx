"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2, Plug } from "lucide-react";
import type { Ups, UpsSummary } from "@church/shared";
import { MONITORING_HEALTH_REFRESH } from "../section-tabs";
import { useCanWrite, StatusLine, inputCls, cardCls, fmtTime } from "../network-cisco/cisco-ui";

const UNKNOWN_CFG = { label: "Unknown", cls: "text-slate-500", dot: "bg-slate-400" };
const STATUS_CFG: Record<string, { label: string; cls: string; dot: string }> = {
  green: { label: "Online", cls: "text-emerald-700 dark:text-emerald-300", dot: "bg-emerald-500" },
  yellow: { label: "On battery", cls: "text-amber-700 dark:text-amber-300", dot: "bg-amber-500" },
  red: { label: "Critical", cls: "text-rose-700 dark:text-rose-300", dot: "bg-rose-500" },
  unknown: UNKNOWN_CFG,
};

function StatusPill({ status }: { status: string }) {
  const c = STATUS_CFG[status] ?? UNKNOWN_CFG;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${c.cls}`}>
      <span className={`h-2 w-2 rounded-full ${c.dot}`} aria-hidden />
      {c.label}
    </span>
  );
}

const pct = (v: number | null): string => (v === null ? "—" : `${v}%`);
const mins = (v: number | null): string => {
  if (v === null) return "—";
  if (v < 60) return `${v}m`;
  return `${Math.floor(v / 60)}h ${v % 60}m`;
};

export default function UpsPage() {
  const canWrite = useCanWrite();
  const [devices, setDevices] = useState<Ups[] | null>(null);
  const [summary, setSummary] = useState<UpsSummary | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [community, setCommunity] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rd, rs] = await Promise.all([
        fetch("/api/ups", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/ups/summary", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (rd.ok) setDevices((await rd.json()) as Ups[]);
      if (rs.ok) setSummary((await rs.json()) as UpsSummary);
    } catch {
      /* transient */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  const refreshBadges = () => window.dispatchEvent(new Event(MONITORING_HEALTH_REFRESH));

  const testConn = async () => {
    if (!host.trim()) return;
    setBusy(true);
    setStatus({ ok: true, text: `Testing ${host.trim()}…` });
    try {
      const r = await fetch("/api/ups/test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ host: host.trim(), community: community.trim() || undefined }),
      });
      const body = (await r.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      setStatus({ ok: Boolean(body?.ok), text: body?.message ?? `Request failed (${r.status})` });
    } finally {
      setBusy(false);
    }
  };

  const addDevice = async () => {
    if (!name.trim() || !host.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await fetch("/api/ups", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          host: host.trim(),
          snmpCommunity: community.trim() || null,
        }),
      });
      if (r.ok) {
        setName("");
        setHost("");
        setCommunity("");
        setStatus({ ok: true, text: `Added ${host.trim()} — polling shortly.` });
        await load();
        refreshBadges();
      } else {
        const body = (await r.json().catch(() => null)) as { message?: unknown } | null;
        const m = body?.message;
        setStatus({ ok: false, text: typeof m === "string" ? m : "Invalid UPS details." });
      }
    } finally {
      setBusy(false);
    }
  };

  const pollNow = async (u: Ups) => {
    setStatus({ ok: true, text: `Polling ${u.name}…` });
    await fetch(`/api/ups/${u.id}/poll`, { method: "POST", credentials: "same-origin" });
    await load();
    refreshBadges();
  };

  const removeDevice = async (u: Ups) => {
    if (!confirm(`Remove UPS "${u.name}"?`)) return;
    await fetch(`/api/ups/${u.id}`, { method: "DELETE", credentials: "same-origin" });
    await load();
    refreshBadges();
  };

  if (!devices) return <p className="text-sm text-slate-500">Loading…</p>;

  const tiles = [
    { label: "Devices", value: summary?.total ?? devices.length, tone: "text-slate-900 dark:text-slate-100" },
    { label: "Online", value: summary?.green ?? 0, tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "On battery", value: summary?.yellow ?? 0, tone: "text-amber-600 dark:text-amber-400" },
    { label: "Critical", value: summary?.red ?? 0, tone: "text-rose-600 dark:text-rose-400" },
  ];

  return (
    <div className="space-y-5">
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className={cardCls}>
            <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className={`mt-1 text-2xl font-semibold ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </section>

      <StatusLine status={status} />

      {canWrite ? (
        <section className={`${cardCls} flex flex-wrap items-end gap-3`}>
          <label className="block">
            <span className="text-xs text-slate-500">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rack UPS"
              className={`${inputCls} mt-1 block w-40`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Host / IP</span>
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="10.0.0.5"
              className={`${inputCls} mt-1 block w-44 font-mono`}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">SNMP community (optional)</span>
            <input
              value={community}
              onChange={(e) => setCommunity(e.target.value)}
              placeholder="public"
              className={`${inputCls} mt-1 block w-40`}
            />
          </label>
          <button
            onClick={() => void testConn()}
            disabled={busy || !host.trim()}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Plug className="h-4 w-4" /> Test
          </button>
          <button
            onClick={() => void addDevice()}
            disabled={busy || !name.trim() || !host.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add UPS
          </button>
        </section>
      ) : null}

      {devices.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No UPS devices yet. Add one above — SNMP defaults (community, version, timeout) are set under{" "}
            <span className="font-medium">Monitoring settings</span>.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Host</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2 text-right">Battery</th>
                <th className="px-3 py-2 text-right">Runtime</th>
                <th className="px-3 py-2 text-right">Load</th>
                <th className="px-3 py-2">Last checked</th>
                {canWrite ? <th className="px-3 py-2 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {devices.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className="px-3 py-2 font-medium">
                    {u.name}
                    {!u.enabled ? <span className="ml-1 text-xs text-slate-400">(disabled)</span> : null}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {u.host}
                    {u.lastError ? (
                      <span className="ml-1 text-amber-600" title={u.lastError}>
                        !
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2">
                    <StatusPill status={u.lastStatus} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(u.batteryPct)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{mins(u.runtimeMin)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(u.loadPct)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fmtTime(u.lastCheckedAt)}</td>
                  {canWrite ? (
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => void pollNow(u)}
                          title="Poll now"
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => void removeDevice(u)}
                          title="Remove UPS"
                          className="rounded p-1.5 text-slate-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/40 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-400">Auto-refreshes every 15s.</p>
    </div>
  );
}
