"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Database, HardDrive, XCircle } from "lucide-react";
import type { ClusterNodeInfo, ClusterStatus } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";

const REFRESH_MS = 5000;
const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

function ago(sec: number): string {
  if (sec < 5) return "just now";
  if (sec < 90) return `${Math.round(sec)} s ago`;
  if (sec < 5400) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)} h ago`;
}

function bytes(n: number | null): string {
  if (n === null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function Badge({ tone, children }: { tone: "green" | "red" | "amber" | "slate"; children: React.ReactNode }) {
  const t = {
    green: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    red: "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300",
    amber: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300",
    slate: "border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300",
  }[tone];
  return <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${t}`}>{children}</span>;
}

function Card({ title, icon: Icon, children }: { title: string; icon?: typeof Database; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {Icon ? <Icon aria-hidden className="h-4 w-4 text-brand-600" /> : null}
        {title}
      </h2>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

export function ClusterView({ initial }: { initial: ClusterStatus }) {
  const [status, setStatus] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/v1/admin/cluster", { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) throw new Error(`status ${res.status}`);
        if (!stopped) {
          setStatus((await res.json()) as ClusterStatus);
          setFetchedAt(Date.now());
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(`Could not refresh: ${(e as Error).message}`);
      }
      if (!stopped) timer.current = setTimeout(() => void tick(), REFRESH_MS);
    };
    timer.current = setTimeout(() => void tick(), REFRESH_MS);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const jobsByNode = useMemo(() => {
    const m = new Map<string, number>();
    for (const j of status.jobs) if (j.held && j.node) m.set(j.node, (m.get(j.node) ?? 0) + 1);
    return m;
  }, [status.jobs]);
  const builds = new Set(status.nodes.filter((n) => n.live && n.role === "full").map((n) => n.version ?? "unknown"));

  async function forget(n: ClusterNodeInfo) {
    if (!confirm(`Forget node ${n.id}? Do this only for a node that is gone for good: if it is still running it will appear again.`)) return;
    setBusy(n.id);
    try {
      const res = await fetch(`/api/v1/admin/cluster/nodes/${encodeURIComponent(n.id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `Could not forget the node (${res.status})`);
      } else {
        setStatus((s) => ({ ...s, nodes: s.nodes.filter((x) => x.id !== n.id) }));
      }
    } finally {
      setBusy(null);
    }
  }

  const errors = status.problems.filter((p) => p.severity === "error");
  const warnings = status.problems.filter((p) => p.severity === "warning");

  return (
    <div className="space-y-5" data-testid="cluster-view">
      {status.problems.length === 0 ? (
        <p className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200" data-testid="cluster-ok">
          <CheckCircle2 aria-hidden className="h-4 w-4" /> Everything this node can see is healthy.
        </p>
      ) : (
        <div className="space-y-2" data-testid="cluster-problems">
          {errors.map((p) => (
            <p key={p.message} className="flex gap-2 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200">
              <XCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {p.message}
            </p>
          ))}
          {warnings.map((p) => (
            <p key={p.message} className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" /> {p.message}
            </p>
          ))}
        </div>
      )}
      {error ? <p className="text-xs text-amber-700 dark:text-amber-400">{error}</p> : null}

      <section>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold">App nodes</h2>
          <p className="text-xs text-slate-500">
            This page was served by <code className="font-mono">{status.self}</code>
            {status.build ? <> (build <code className="font-mono">{status.build}</code>)</> : null}. Refreshes every {REFRESH_MS / 1000} s; data from {Math.max(0, Math.round((Date.now() - fetchedAt) / 1000))} s ago.
          </p>
        </div>
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm" data-testid="cluster-nodes">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Node</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Address</th>
                <th className="px-3 py-2">Build</th>
                <th className="px-3 py-2">Running since</th>
                <th className="px-3 py-2">Last check-in</th>
                <th className="px-3 py-2">Leads</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {status.nodes.map((n) => (
                <tr key={n.id} className={n.live ? "" : "opacity-70"} data-node-id={n.id}>
                  <td className="px-3 py-2 font-medium">
                    {n.id} {n.self ? <Badge tone="slate">this node</Badge> : null} {n.role === "data" ? <Badge tone="slate">witness</Badge> : null}
                  </td>
                  <td className="px-3 py-2">{n.live ? <Badge tone="green">live</Badge> : <Badge tone="red">stopped</Badge>}</td>
                  <td className="px-3 py-2 font-mono text-xs">{n.addr ?? "-"}</td>
                  <td className={`px-3 py-2 font-mono text-xs ${builds.size > 1 && n.live && n.role === "full" ? "text-amber-700 dark:text-amber-400" : ""}`}>{n.version ?? "-"}</td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400"><LocalDateTime value={n.startedAt} options={WHEN} /></td>
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-400">{ago(n.ageSec)}</td>
                  <td className="px-3 py-2 text-xs">{jobsByNode.get(n.id) ?? 0} jobs</td>
                  <td className="px-3 py-2 text-right">
                    {!n.live && n.ageSec >= 60 ? (
                      <button type="button" disabled={busy === n.id} onClick={() => void forget(n)} className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900">
                        Forget
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {status.nodes.length === 0 ? (
                <tr><td colSpan={8} className="px-3 py-4 text-center text-slate-500">No node has checked in yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-slate-500">A node that is stopped on purpose removes itself; one that crashed stays listed as stopped until it is back, forgotten here, or an hour has passed.</p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Database" icon={Database}>
          <p className="flex items-center gap-2">
            {status.database.ok ? <Badge tone="green">answering</Badge> : <Badge tone="red">not answering</Badge>}
            <span className="font-medium">{status.database.label}</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {status.database.latencyMs !== null ? `${status.database.latencyMs} ms for a trivial query from this node.` : null}
            {status.database.error ? ` ${status.database.error}` : null}
          </p>
        </Card>
        <Card title="Object store (uploaded files and backups)" icon={HardDrive}>
          <p className="flex flex-wrap items-center gap-2">
            {status.store.ok ? <Badge tone="green">answering</Badge> : <Badge tone="red">not answering</Badge>}
            <span className="font-medium">{status.store.kind === "garage" ? "Garage (bundled)" : "S3-compatible store"}</span>
          </p>
          <p className="mt-1 break-all text-xs text-slate-500">
            {status.store.endpoint} / {status.store.bucket}
            {status.store.latencyMs !== null ? ` - ${status.store.latencyMs} ms` : ""}
            {status.store.error ? ` - ${status.store.error}` : ""}
          </p>
        </Card>
      </div>

      {status.store.garage ? (
        <section>
          <h2 className="mb-2 text-base font-semibold">
            Object store nodes <span className="text-xs font-normal text-slate-500">layout version {status.store.garage.layoutVersion}</span>
          </h2>
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm" data-testid="garage-nodes">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Node</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Address</th>
                  <th className="px-3 py-2">Zone</th>
                  <th className="px-3 py-2">Offered</th>
                  <th className="px-3 py-2">Disk free</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {status.store.garage.nodes.map((g) => (
                  <tr key={g.id}>
                    <td className="px-3 py-2 font-mono text-xs">{g.id.slice(0, 12)}</td>
                    <td className="px-3 py-2">
                      {g.up ? <Badge tone="green">up</Badge> : <Badge tone="red">down</Badge>} {g.draining ? <Badge tone="amber">draining</Badge> : null}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{g.addr ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">{g.zone ?? "-"}</td>
                    <td className="px-3 py-2 text-xs">{bytes(g.capacityBytes)}</td>
                    <td className="px-3 py-2 text-xs">{g.dataAvailableBytes !== null && g.dataTotalBytes !== null ? `${bytes(g.dataAvailableBytes)} of ${bytes(g.dataTotalBytes)}` : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-base font-semibold">Background jobs</h2>
        <p className="mb-2 text-xs text-slate-500">Each job runs on one node at a time. If its node stops, another takes it over within about 30 seconds.</p>
        <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="w-full text-left text-sm" data-testid="cluster-jobs">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <tr>
                <th className="px-3 py-2">Job</th>
                <th className="px-3 py-2">Led by</th>
                <th className="px-3 py-2">Handovers</th>
                <th className="px-3 py-2">Lease</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {status.jobs.map((j) => (
                <tr key={j.name} data-job={j.name}>
                  <td className="px-3 py-1.5 font-mono text-xs">{j.name}</td>
                  <td className="px-3 py-1.5 text-xs">{j.held && j.node ? j.node : <Badge tone="amber">nobody</Badge>}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">{j.epoch !== null ? Math.max(0, j.epoch - 1) : "-"}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600 dark:text-slate-400">{j.expiresInSec === null ? "-" : j.held ? `renews, lapses in ${j.expiresInSec} s` : "lapsed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {status.operations.length > 0 ? (
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">
            One-off work in progress: {status.operations.map((o) => `${o.name} (on ${o.node ?? "?"})`).join(", ")}.
          </p>
        ) : null}
      </section>
    </div>
  );
}
