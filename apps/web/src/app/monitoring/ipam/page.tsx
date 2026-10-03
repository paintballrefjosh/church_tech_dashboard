"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Trash2, Radar, Plus, ScanLine, Pencil } from "lucide-react";
import type { IpamSubnet, IpamDiscoveredSubnet, IpamSummary } from "@church/shared";
import { MONITORING_HEALTH_REFRESH } from "../section-tabs";
import { useCanWrite, StatusLine, inputCls, cardCls, fmtTime, Modal, Field } from "../network-cisco/cisco-ui";

interface EditForm {
  id: string;
  cidr: string;
  label: string;
  vlanId: string;
  gateway: string;
}

const SOURCE_BADGE: Record<string, string> = {
  manual: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  cisco: "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  unifi: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
};

function SourceBadge({ source, detail }: { source: string; detail?: string | null }) {
  return (
    <span
      title={detail ?? undefined}
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        SOURCE_BADGE[source] ?? SOURCE_BADGE.manual
      }`}
    >
      {source}
    </span>
  );
}

export default function IpamPage() {
  const canWrite = useCanWrite();
  const [subnets, setSubnets] = useState<IpamSubnet[] | null>(null);
  const [summary, setSummary] = useState<IpamSummary | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [cidr, setCidr] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const [discovered, setDiscovered] = useState<IpamDiscoveredSubnet[] | null>(null);
  const [discovering, setDiscovering] = useState(false);

  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rs, rsum] = await Promise.all([
        fetch("/api/ipam/subnets", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/ipam/summary", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (rs.ok) setSubnets((await rs.json()) as IpamSubnet[]);
      if (rsum.ok) setSummary((await rsum.json()) as IpamSummary);
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

  const addSubnet = async () => {
    if (!cidr.trim()) return;
    setBusy(true);
    setStatus(null);
    try {
      const r = await fetch("/api/ipam/subnets", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cidr: cidr.trim(), label: label.trim() || undefined }),
      });
      if (r.ok) {
        setCidr("");
        setLabel("");
        setStatus({ ok: true, text: `Added ${cidr.trim()} — scanning now.` });
        await load();
        refreshBadges();
      } else {
        const body = (await r.json().catch(() => null)) as { message?: unknown } | null;
        setStatus({ ok: false, text: describeError(body) });
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleScan = async (s: IpamSubnet) => {
    await fetch(`/api/ipam/subnets/${s.id}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scanEnabled: !s.scanEnabled }),
    });
    await load();
    refreshBadges();
  };

  const scanNow = async (s: IpamSubnet) => {
    setStatus({ ok: true, text: `Scanning ${s.cidr}…` });
    await fetch(`/api/ipam/subnets/${s.id}/scan`, { method: "POST", credentials: "same-origin" });
    // Give the background sweep a moment, then refresh.
    setTimeout(() => void load(), 4000);
  };

  const removeSubnet = async (s: IpamSubnet) => {
    if (!confirm(`Remove ${s.cidr} and its discovered hosts?`)) return;
    await fetch(`/api/ipam/subnets/${s.id}`, { method: "DELETE", credentials: "same-origin" });
    await load();
    refreshBadges();
  };

  const openEdit = (s: IpamSubnet) => {
    setEditForm({ id: s.id, cidr: s.cidr, label: s.label, vlanId: s.vlanId != null ? String(s.vlanId) : "", gateway: s.gateway ?? "" });
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editForm) return;
    setEditBusy(true);
    try {
      const vlan = editForm.vlanId.trim();
      const r = await fetch(`/api/ipam/subnets/${editForm.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: editForm.label.trim(),
          vlanId: vlan ? Number(vlan) : null,
          gateway: editForm.gateway.trim() || null,
        }),
      });
      if (r.ok) {
        setStatus({ ok: true, text: `Saved ${editForm.cidr}.` });
        setEditForm(null);
        await load();
        refreshBadges();
      } else {
        const body = (await r.json().catch(() => null)) as { message?: unknown } | null;
        setStatus({ ok: false, text: describeError(body) });
      }
    } finally {
      setEditBusy(false);
    }
  };

  const discover = async () => {
    setDiscovering(true);
    try {
      const r = await fetch("/api/ipam/discover", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) setDiscovered((await r.json()) as IpamDiscoveredSubnet[]);
    } finally {
      setDiscovering(false);
    }
  };

  const adopt = async (d: IpamDiscoveredSubnet) => {
    await fetch("/api/ipam/adopt", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cidr: d.cidr,
        source: d.source,
        sourceDetail: d.sourceDetail,
        vlanId: d.vlanId,
        gateway: d.gateway,
        label: d.label,
      }),
    });
    await Promise.all([load(), discover()]);
    refreshBadges();
  };

  if (!subnets) return <p className="text-sm text-slate-500">Loading…</p>;

  const tiles = [
    { label: "Subnets", value: summary?.subnets ?? subnets.length, tone: "text-slate-900 dark:text-slate-100" },
    { label: "Scanning", value: summary?.scanning ?? 0, tone: "text-sky-600 dark:text-sky-400" },
    { label: "Hosts", value: summary?.hosts ?? 0, tone: "text-slate-900 dark:text-slate-100" },
    { label: "Up", value: summary?.up ?? 0, tone: "text-emerald-600 dark:text-emerald-400" },
  ];

  const newCandidates = (discovered ?? []).filter((d) => !d.existing);

  return (
    <div className="space-y-5">
      {summary && !summary.enabled ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Background scanning is off. Subnets are only swept when you click{" "}
          <span className="font-medium">Scan</span>, or add one. Turn on periodic scanning and tune the interval,
          DNS/NetBIOS/UniFi name lookups under{" "}
          <Link href="/admin/settings/monitoring" className="font-medium underline">
            Monitoring settings
          </Link>
          .
        </div>
      ) : null}

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
            <span className="text-xs text-slate-500">Subnet (CIDR)</span>
            <input
              value={cidr}
              onChange={(e) => setCidr(e.target.value)}
              placeholder="10.0.10.0/24"
              className={`${inputCls} mt-1 block w-44 font-mono`}
              onKeyDown={(e) => e.key === "Enter" && void addSubnet()}
            />
          </label>
          <label className="block">
            <span className="text-xs text-slate-500">Label (optional)</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Office VLAN"
              className={`${inputCls} mt-1 block w-48`}
              onKeyDown={(e) => e.key === "Enter" && void addSubnet()}
            />
          </label>
          <button
            onClick={() => void addSubnet()}
            disabled={busy || !cidr.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" /> Add subnet
          </button>
          <button
            onClick={() => void discover()}
            disabled={discovering}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Radar className={`h-4 w-4 ${discovering ? "animate-pulse" : ""}`} /> Discover from Cisco / UniFi
          </button>
        </section>
      ) : null}

      {newCandidates.length > 0 ? (
        <section className={cardCls}>
          <h2 className="mb-2 text-sm font-semibold">Discovered ranges</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-1 pr-3">CIDR</th>
                  <th className="py-1 pr-3">Name</th>
                  <th className="py-1 pr-3">Source</th>
                  <th className="py-1 pr-3">VLAN</th>
                  <th className="py-1 pr-3">Gateway</th>
                  {canWrite ? <th className="py-1" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {newCandidates.map((d) => (
                  <tr key={d.cidr}>
                    <td className="py-1.5 pr-3 font-mono text-xs">{d.cidr}</td>
                    <td className="py-1.5 pr-3 text-xs text-slate-600 dark:text-slate-400">{d.label || "—"}</td>
                    <td className="py-1.5 pr-3">
                      <SourceBadge source={d.source} detail={d.sourceDetail} />
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{d.vlanId ?? "—"}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs">{d.gateway ?? "—"}</td>
                    {canWrite ? (
                      <td className="py-1.5 text-right">
                        <button
                          onClick={() => void adopt(d)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                        >
                          <ScanLine className="h-3.5 w-3.5" /> Add &amp; scan
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : discovered && newCandidates.length === 0 ? (
        <p className="text-xs text-slate-400">No new ranges found — everything discoverable is already managed.</p>
      ) : null}

      {subnets.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No subnets yet. Add a CIDR above, or discover ranges from your Cisco switches and UniFi controller.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Subnet</th>
                <th className="px-3 py-2">Label</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">VLAN</th>
                <th className="px-3 py-2 text-right">Hosts</th>
                <th className="px-3 py-2">Last scan</th>
                <th className="px-3 py-2">Scan</th>
                {canWrite ? <th className="px-3 py-2 text-right">Actions</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {subnets.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/monitoring/ipam/${s.id}`} className="text-brand-600 hover:underline">
                      {s.cidr}
                    </Link>
                    {s.lastError ? (
                      <span className="ml-1 text-amber-600" title={s.lastError}>
                        !
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{s.label || "—"}</td>
                  <td className="px-3 py-2">
                    <SourceBadge source={s.source} detail={s.sourceDetail} />
                  </td>
                  <td className="px-3 py-2 text-xs">{s.vlanId ?? "—"}</td>
                  <td className="px-3 py-2 text-right text-xs tabular-nums">
                    <span className="text-emerald-600 dark:text-emerald-400" title="Active hosts">
                      {s.aliveCount}
                    </span>
                    <span className="text-slate-400" title="Usable IPs in the subnet"> / {s.usableHosts}</span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fmtTime(s.lastScanFinishedAt)}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => canWrite && void toggleScan(s)}
                      disabled={!canWrite}
                      title={s.scanEnabled ? "Periodic scanning on" : "Periodic scanning off"}
                      className={`inline-flex h-5 w-9 items-center rounded-full px-0.5 transition ${
                        s.scanEnabled ? "bg-emerald-500" : "bg-slate-300 dark:bg-slate-700"
                      } ${canWrite ? "cursor-pointer" : "cursor-default opacity-70"}`}
                    >
                      <span
                        className={`h-4 w-4 rounded-full bg-white transition ${s.scanEnabled ? "translate-x-4" : ""}`}
                      />
                    </button>
                  </td>
                  {canWrite ? (
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(s)}
                          title="Edit subnet"
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => void scanNow(s)}
                          title="Scan now"
                          className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        >
                          <RefreshCw className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => void removeSubnet(s)}
                          title="Remove subnet"
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

      {editForm ? (
        <Modal title={`Edit ${editForm.cidr}`} onClose={() => setEditForm(null)}>
          <form onSubmit={saveEdit} className="space-y-3 text-sm">
            <Field label="Subnet (CIDR)">
              <input disabled value={editForm.cidr} className={`w-full font-mono text-xs opacity-60 ${inputCls}`} />
            </Field>
            <Field label="Label">
              <input
                value={editForm.label}
                onChange={(e) => setEditForm({ ...editForm, label: e.target.value })}
                placeholder="Office VLAN"
                className={`w-full ${inputCls}`}
              />
              <span className="mt-1 block text-[11px] text-slate-400">
                Saving here stops this label from following the source system's name (UniFi network / Cisco VLAN) —
                it won't be overwritten by the periodic sync.
              </span>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="VLAN ID">
                <input
                  type="number"
                  min={1}
                  max={4094}
                  value={editForm.vlanId}
                  onChange={(e) => setEditForm({ ...editForm, vlanId: e.target.value })}
                  className={`w-full ${inputCls}`}
                />
              </Field>
              <Field label="Gateway">
                <input
                  value={editForm.gateway}
                  onChange={(e) => setEditForm({ ...editForm, gateway: e.target.value })}
                  placeholder="10.0.10.1"
                  className={`w-full font-mono text-xs ${inputCls}`}
                />
              </Field>
            </div>
            <div className="flex items-center justify-end gap-2 pt-1">
              <button type="button" onClick={() => setEditForm(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700">
                Cancel
              </button>
              <button type="submit" disabled={editBusy} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
                Save changes
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}

function describeError(body: { message?: unknown } | null): string {
  if (!body) return "Request failed.";
  const m = body.message;
  if (typeof m === "string") return m;
  // Zod flatten shape: { formErrors, fieldErrors }.
  const flat = m as { fieldErrors?: Record<string, string[]> } | undefined;
  const first = flat?.fieldErrors ? Object.values(flat.fieldErrors)[0]?.[0] : undefined;
  return first ?? "Invalid subnet.";
}
