"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, RefreshCw } from "lucide-react";
import type { IpamSubnet, IpamHost } from "@church/shared";
import { useCanWrite, cardCls, fmtTime } from "../../network-cisco/cisco-ui";

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

  const load = useCallback(async () => {
    try {
      const [rs, rh] = await Promise.all([
        fetch(`/api/ipam/subnets/${id}`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/ipam/subnets/${id}/hosts`, { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (rs.ok) setSubnet((await rs.json()) as IpamSubnet);
      if (rh.ok) setHosts((await rh.json()) as IpamHost[]);
    } catch {
      /* transient */
    }
  }, [id]);

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
