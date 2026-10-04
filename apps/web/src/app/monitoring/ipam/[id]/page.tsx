"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, RefreshCw, Pencil, Check, X } from "lucide-react";
import type { IpamSubnet, IpamHost, DnsSyncStatus, DnsSyncHostState } from "@church/shared";
import { useCanWrite, cardCls, fmtTime, inputCls } from "../../network-cisco/cisco-ui";

const DNS_STATE: Record<DnsSyncHostState, { label: string; dot: string }> = {
  ok: { label: "Published", dot: "bg-emerald-500" },
  conflict: { label: "Conflict", dot: "bg-rose-500" },
  error: { label: "Error", dot: "bg-rose-500" },
  unnamed: { label: "No name", dot: "bg-slate-400" },
  stale: { label: "Stale", dot: "bg-slate-400" },
};

/** Best display name for a host across its sources, with the source it came
 * from (for a tooltip). UniFi alias/hostname first — it's the friendliest and
 * covers phones/IoT that never answer the scanner directly — then reverse DNS,
 * then NetBIOS. */
function hostName(h: IpamHost): { name: string | null; source: string | null } {
  if (h.unifiName) return { name: h.unifiName, source: "UniFi" };
  if (h.hostname) return { name: h.hostname, source: "DNS" };
  if (h.netbiosName) return { name: h.netbiosName, source: "NetBIOS" };
  return { name: null, source: null };
}

export default function IpamSubnetPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const canWrite = useCanWrite();
  const [subnet, setSubnet] = useState<IpamSubnet | null>(null);
  const [hosts, setHosts] = useState<IpamHost[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [dns, setDns] = useState<DnsSyncStatus | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string; error: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const [rs, rh, rd] = await Promise.all([
        fetch(`/api/ipam/subnets/${id}`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/ipam/subnets/${id}/hosts`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/dns/sync/status`, { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (rs.ok) setSubnet((await rs.json()) as IpamSubnet);
      if (rh.ok) setHosts((await rh.json()) as IpamHost[]);
      if (rd.ok) setDns((await rd.json()) as DnsSyncStatus);
    } catch {
      /* transient */
    }
  }, [id]);

  const patch = async (url: string, body: unknown): Promise<string | null> => {
    const r = await fetch(url, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    const b = (await r.json().catch(() => null)) as { message?: unknown; fieldErrors?: Record<string, string[]> } | null;
    if (typeof b?.message === "string") return b.message;
    return Object.values(b?.fieldErrors ?? {}).flat().join("; ") || `Request failed (HTTP ${r.status})`;
  };

  const togglePublish = async () => {
    if (!subnet) return;
    const err = await patch(`/api/ipam/subnets/${id}`, { dnsSync: !subnet.dnsSync });
    if (!err) await load();
  };

  const saveName = async () => {
    if (!editing) return;
    const err = await patch(`/api/ipam/hosts/${editing.id}`, { dnsName: editing.value.trim() || null });
    if (err) {
      setEditing({ ...editing, error: err });
      return;
    }
    setEditing(null);
    await load();
  };

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [load]);

  const scanNow = async () => {
    setScanning(true);
    await fetch(`/api/ipam/subnets/${id}/scan`, { method: "POST", credentials: "same-origin" });
    setTimeout(async () => {
      await load();
      setScanning(false);
    }, 4000);
  };

  if (!subnet) return <p className="text-sm text-slate-500">Loading…</p>;

  const up = hosts?.filter((h) => h.isUp).length ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/monitoring/ipam" className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" /> All subnets
          </Link>
          <h2 className="font-mono text-lg font-semibold">{subnet.cidr}</h2>
          <p className="text-xs text-slate-500">
            {subnet.label ? `${subnet.label} · ` : ""}
            {subnet.gateway ? `gw ${subnet.gateway} · ` : ""}
            {subnet.vlanId ? `VLAN ${subnet.vlanId} · ` : ""}
            source {subnet.source}
            {subnet.sourceDetail ? ` (${subnet.sourceDetail})` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        {canWrite ? (
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm" title="Publish named hosts in this subnet as DNS records">
            <input type="checkbox" checked={subnet.dnsSync} onChange={() => void togglePublish()} />
            Publish to DNS
          </label>
        ) : subnet.dnsSync ? (
          <span className="text-xs text-slate-500">Published to DNS</span>
        ) : null}
        {canWrite ? (
          <button
            onClick={() => void scanNow()}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${scanning ? "animate-spin" : ""}`} /> {scanning ? "Scanning…" : "Scan now"}
          </button>
        ) : null}
        </div>
      </div>

      {subnet.dnsSync && dns && !dns.enabled ? (
        <p className="rounded-md border border-slate-300 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
          DNS sync is off, so nothing is written yet. Check the plan on the{" "}
          <Link href="/monitoring/dns?view=sync" className="font-medium text-brand-700 hover:underline dark:text-brand-300">
            DNS tab
          </Link>{" "}
          and turn it on in Monitoring settings.
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Hosts seen", value: subnet.hostCount, tone: "text-slate-900 dark:text-slate-100" },
          { label: "Up now", value: up, tone: "text-emerald-600 dark:text-emerald-400" },
          { label: "Scanning", value: subnet.scanEnabled ? "On" : "Off", tone: "text-sky-600 dark:text-sky-400" },
          { label: "Last scan", value: fmtTime(subnet.lastScanFinishedAt), tone: "text-xs text-slate-600 dark:text-slate-400" },
        ].map((t) => (
          <div key={t.label} className={cardCls}>
            <div className="text-xs uppercase tracking-wide text-slate-500">{t.label}</div>
            <div className={`mt-1 text-2xl font-semibold ${t.tone}`}>{t.value}</div>
          </div>
        ))}
      </section>

      {subnet.lastError ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          {subnet.lastError}
        </p>
      ) : null}

      {!hosts || hosts.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No hosts discovered yet.{canWrite ? " Run a scan to sweep this range." : ""}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2" />
                <th className="px-3 py-2">IP</th>
                <th className="px-3 py-2">Name</th>
                {subnet.dnsSync ? <th className="px-3 py-2">DNS</th> : null}
                <th className="px-3 py-2">MAC</th>
                <th className="px-3 py-2">Via</th>
                <th className="px-3 py-2">Open ports</th>
                <th className="px-3 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {hosts.map((h) => (
                <tr key={h.id} className={`hover:bg-slate-50 dark:hover:bg-slate-900 ${h.isUp ? "" : "opacity-60"}`}>
                  <td className="px-3 py-2">
                    <span
                      title={h.isUp ? "Up" : "Down"}
                      className={`inline-block h-2 w-2 rounded-full ${h.isUp ? "bg-emerald-500" : "bg-slate-400"}`}
                    />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{h.ipAddress}</td>
                  <td className="px-3 py-2 text-xs">
                    {(() => {
                      const { name, source } = hostName(h);
                      if (!name) return "—";
                      return (
                        <span title={source ? `via ${source}` : undefined}>
                          {name}
                          {source ? (
                            <span className="ml-1.5 text-[10px] uppercase tracking-wide text-slate-400">{source}</span>
                          ) : null}
                        </span>
                      );
                    })()}
                  </td>
                  {subnet.dnsSync ? (
                    <td className="px-3 py-2 text-xs">
                      {editing?.id === h.id ? (
                        <div>
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              value={editing.value}
                              onChange={(e) => setEditing({ ...editing, value: e.target.value, error: null })}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveName();
                                if (e.key === "Escape") setEditing(null);
                              }}
                              placeholder="automatic"
                              aria-label="DNS name override"
                              className={`${inputCls} w-36 px-2 py-1 font-mono text-xs`}
                            />
                            <button onClick={() => void saveName()} title="Save" className="rounded p-1 text-emerald-600 hover:bg-slate-100 dark:hover:bg-slate-800">
                              <Check className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setEditing(null)} title="Cancel" className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          {editing.error ? <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{editing.error}</p> : null}
                        </div>
                      ) : (
                        (() => {
                          const o = dns?.hosts[h.id];
                          const st = o ? DNS_STATE[o.state] : null;
                          return (
                            <span className="inline-flex items-center gap-1.5" title={o?.message ?? (o ? undefined : "Not synced yet")}>
                              {st ? <span className={`h-2 w-2 rounded-full ${st.dot}`} aria-hidden /> : null}
                              <span className="font-mono">{o?.fqdn ? o.fqdn.split(".")[0] : st ? st.label : "—"}</span>
                              {h.dnsName ? <span className="text-[10px] uppercase tracking-wide text-slate-400">override</span> : null}
                              {canWrite ? (
                                <button
                                  onClick={() => setEditing({ id: h.id, value: h.dnsName ?? "", error: null })}
                                  title="Set the DNS name for this host"
                                  className="rounded p-0.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                                >
                                  <Pencil className="h-3 w-3" />
                                </button>
                              ) : null}
                            </span>
                          );
                        })()
                      )}
                    </td>
                  ) : null}
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">{h.macAddress ?? "—"}</td>
                  <td className="px-3 py-2 text-xs uppercase text-slate-500">{h.respondedVia ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                    {h.openPorts.length ? h.openPorts.join(", ") : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{fmtTime(h.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-400">Auto-refreshes every 10s.</p>
    </div>
  );
}
