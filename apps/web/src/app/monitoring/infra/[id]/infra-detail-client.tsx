"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState, type FormEvent } from "react";
import { Pencil, Trash2, AlertTriangle, CircleCheck, Download, Loader2, RefreshCw, X } from "lucide-react";
import type {
  InfraTarget,
  InfraEntity,
  InfraMetricPoint,
  MonitorIncident,
  InfraUpdateRun,
  InfraDiscoveredService,
} from "@church/shared";
import { OS_META, StatusPill, Gauge, Stat, formatBytes, formatBps, formatUptime } from "../infra-ui";
import { MetricChart, MultiSeriesChart } from "../charts";
import { useRealtimeRoom } from "@/lib/use-realtime";
import { useCanWrite } from "../../network-cisco/cisco-ui";

const RANGES: { key: string; label: string; ms: number }[] = [
  { key: "1h", label: "1h", ms: 3_600_000 },
  { key: "6h", label: "6h", ms: 6 * 3_600_000 },
  { key: "24h", label: "24h", ms: 24 * 3_600_000 },
  { key: "7d", label: "7d", ms: 7 * 86_400_000 },
];

type Rec = Record<string, unknown>;
const num = (o: Rec | null | undefined, k: string): number | null => {
  const v = o?.[k];
  return typeof v === "number" ? v : null;
};

// Facet accessors for the extra history charts. `point.metrics` differs by
// resolution: raw samples carry nested facets (metrics.load.one,
// metrics.temperatureC, metrics.interfaces[]); rollups carry only aggregated
// scalars (metrics.loadOne.avg, metrics.temperatureC.avg) and no per-device
// arrays — so network/disk populate at short ranges only.
const metricsOf = (p: InfraMetricPoint): Rec => (p.metrics ?? {}) as Rec;

function loadAt(p: InfraMetricPoint, which: "one" | "five" | "fifteen"): number | null {
  const m = metricsOf(p);
  const raw = m.load as Rec | undefined;
  if (raw && typeof raw[which] === "number") return raw[which] as number;
  const key = which === "one" ? "loadOne" : which === "five" ? "loadFive" : "loadFifteen";
  const roll = m[key] as Rec | undefined;
  if (roll && typeof roll.avg === "number") return roll.avg as number;
  return null;
}

function tempAt(p: InfraMetricPoint): number | null {
  const v = metricsOf(p).temperatureC;
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && typeof (v as Rec).avg === "number") return (v as Rec).avg as number;
  return null;
}

function flowAgg(p: InfraMetricPoint, arrKey: "interfaces" | "disks", field: string): number | null {
  const arr = metricsOf(p)[arrKey] as Array<Rec> | undefined;
  if (!Array.isArray(arr)) return null;
  let sum = 0;
  let any = false;
  for (const it of arr) {
    const v = it[field];
    if (typeof v === "number") {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

export function InfraDetailClient({
  initialTarget,
  initialEntities,
  initialIncidents,
  initialUpdateRuns,
}: {
  initialTarget: InfraTarget;
  initialEntities: InfraEntity[];
  initialIncidents: MonitorIncident[];
  initialUpdateRuns: InfraUpdateRun[];
}) {
  const router = useRouter();
  const [target, setTarget] = useState(initialTarget);
  const [entities, setEntities] = useState(initialEntities);
  const [incidents, setIncidents] = useState(initialIncidents);
  const [points, setPoints] = useState<InfraMetricPoint[]>([]);
  const [range, setRange] = useState("1h");
  const [err, setErr] = useState<string | null>(null);
  const meta = OS_META[target.os];

  const [updateRuns, setUpdateRuns] = useState(initialUpdateRuns);
  const [runModalOpen, setRunModalOpen] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const runningRun = updateRuns.find((r) => r.status === "running") ?? null;

  const loadRuns = useCallback(async () => {
    try {
      const r = await fetch(`/api/infra/targets/${target.id}/update-runs`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (r.ok) setUpdateRuns((await r.json()) as InfraUpdateRun[]);
    } catch {
      /* transient */
    }
  }, [target.id]);

  // While a run is in progress, poll its own endpoint (not just realtime infra:
  // update, which only fires on the regular metrics-poll cadence and wouldn't
  // otherwise reflect the run finishing promptly).
  useEffect(() => {
    if (!runningRun) return;
    const id = setInterval(() => void loadRuns(), 4_000);
    return () => clearInterval(id);
  }, [runningRun, loadRuns]);

  const [checkingUpdates, setCheckingUpdates] = useState(false);
  async function checkForUpdates() {
    setCheckingUpdates(true);
    try {
      await fetch(`/api/infra/targets/${target.id}/poll-now`, { method: "POST", credentials: "same-origin" });
      await refreshState();
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function startRun(reboot: boolean, fullUpgrade: boolean, includePhased: boolean) {
    setStarting(true);
    setRunErr(null);
    try {
      const r = await fetch(`/api/infra/targets/${target.id}/update-run`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reboot, fullUpgrade, includePhased }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string };
        setRunErr(typeof b.message === "string" ? b.message : `Failed to start (${r.status})`);
        return;
      }
      setRunModalOpen(false);
      await loadRuns();
    } finally {
      setStarting(false);
    }
  }

  const loadSeries = useCallback(async () => {
    const r = RANGES.find((x) => x.key === range) ?? RANGES[0]!;
    const to = new Date();
    const from = new Date(to.getTime() - r.ms);
    try {
      const res = await fetch(
        `/api/infra/targets/${target.id}/metrics?entityKind=target&from=${from.toISOString()}&to=${to.toISOString()}`,
        { credentials: "same-origin", cache: "no-store" },
      );
      if (res.ok) {
        const body = (await res.json()) as { points: InfraMetricPoint[] };
        setPoints(body.points ?? []);
      }
    } catch {
      /* transient */
    }
  }, [target.id, range]);

  useEffect(() => {
    void loadSeries();
  }, [loadSeries]);

  const tid = initialTarget.id;
  const refreshState = useCallback(async () => {
    try {
      const [t, e] = await Promise.all([
        fetch(`/api/infra/targets/${tid}`, { credentials: "same-origin", cache: "no-store" }),
        fetch(`/api/infra/targets/${tid}/entities`, { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (t.ok) setTarget((await t.json()) as InfraTarget);
      if (e.ok) setEntities((await e.json()) as InfraEntity[]);
    } catch {
      /* transient */
    }
    void loadSeries();
  }, [tid, loadSeries]);

  const { connected } = useRealtimeRoom(
    `infra:${tid}`,
    { "infra:update": () => void refreshState() },
    () => void refreshState(),
  );

  useEffect(() => {
    if (connected) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void refreshState();
    }, 15_000);
    return () => clearInterval(id);
  }, [connected, refreshState]);

  // Shared by every target.options field edited inline on this page (ignored
  // mounts, watched services): optimistic local update, PATCH in the
  // background, and on failure surface the error + resync from the server.
  const patchOptions = useCallback(
    async (nextOptions: Record<string, unknown>, errLabel: string) => {
      setTarget((t) => ({ ...t, options: nextOptions }));
      try {
        const r = await fetch(`/api/infra/targets/${target.id}`, {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ options: nextOptions }),
        });
        if (!r.ok) throw new Error(`Failed to save (${r.status})`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : `Failed to update ${errLabel}`);
        await refreshState();
      }
    },
    [target.id, refreshState],
  );

  // The switch's displayed state reads target.options.ignoredMounts directly
  // (not the per-poll `ignored` flag on the sample, which only catches up on
  // the next poll).
  const toggleIgnoredMount = useCallback(
    (mount: string, ignore: boolean) => {
      const current = (target.options.ignoredMounts as string[] | undefined) ?? [];
      const nextIgnored = ignore ? [...new Set([...current, mount])] : current.filter((m) => m !== mount);
      void patchOptions({ ...target.options, ignoredMounts: nextIgnored }, "ignored filesystems");
    },
    [target.options, patchOptions],
  );

  const addWatchedService = useCallback(
    (name: string) => {
      const current = (target.options.watchedServices as string[] | undefined) ?? [];
      if (current.includes(name)) return;
      void patchOptions({ ...target.options, watchedServices: [...current, name] }, "watched services");
    },
    [target.options, patchOptions],
  );

  const removeWatchedService = useCallback(
    (name: string) => {
      const current = (target.options.watchedServices as string[] | undefined) ?? [];
      void patchOptions({ ...target.options, watchedServices: current.filter((n) => n !== name) }, "watched services");
    },
    [target.options, patchOptions],
  );

  async function destroy() {
    if (!confirm(`Delete target "${target.name}"? All metrics history is removed. This cannot be undone.`)) return;
    const r = await fetch(`/api/infra/targets/${target.id}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) router.push("/monitoring/infra");
    else setErr(`Delete failed (${r.status})`);
  }

  const sample = (target.lastSample ?? null) as Rec | null;
  const sampleMetrics = (sample?.metrics ?? null) as Rec | null;
  // VMs frequently either have no ACPI thermal zone at all (temperatureC
  // already null then) or a hypervisor-synthesized fake one that reports a
  // real-looking number that isn't an actual sensor reading — isVirtual
  // (systemd-detect-virt, see collectors/linux.ts) catches that second case
  // a null-check alone can't. Defaults to shown (true) until a sample
  // arrives, so the card doesn't flash away then back for a bare-metal host.
  const showTemp = sampleMetrics ? sampleMetrics.isVirtual !== true && num(sampleMetrics, "temperatureC") !== null : true;

  return (
    <div className="space-y-5 text-sm">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3">
        <meta.Icon className="h-6 w-6 text-brand-600" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">{target.name}</h1>
          <div className="font-mono text-xs text-slate-500">
            {meta.label} · {target.host}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-3">
          <StatusPill status={target.status} enabled={target.enabled} />
          <Link
            href={`/monitoring/infra/${target.id}/edit`}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            <Pencil className="h-4 w-4" aria-hidden /> Edit
          </Link>
        </div>
      </header>

      {target.lastError ? (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-300">
          {target.lastError}
        </div>
      ) : null}

      {/* Headline stats */}
      <section className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
          <Gauge label="CPU" pct={num(sample, "cpuPct")} />
        </div>
        <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
          <Gauge label="Memory" pct={num(sample, "memPct")} />
        </div>
        <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
          <Gauge label="Disk (max)" pct={num(sample, "diskPctMax")} />
        </div>
        <Stat
          label="Last poll"
          value={target.lastPolledAt ? new Date(target.lastPolledAt).toLocaleTimeString() : "—"}
        />
      </section>

      {/* Time-series charts */}
      <section className="space-y-3">
        <div className="flex items-center gap-1">
          <span className="mr-2 text-xs uppercase tracking-wide text-slate-500">History</span>
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setRange(r.key)}
              className={`rounded-md px-2 py-1 text-xs ${
                range === r.key
                  ? "bg-brand-600 text-white"
                  : "border border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <MetricChart points={points} field="cpuPct" color="#10b981" title="CPU %" domainMax={100} />
          <MetricChart points={points} field="memPct" color="#0ea5e9" title="Memory %" domainMax={100} />
          <MetricChart points={points} field="diskPctMax" color="#f59e0b" title="Disk % (max)" domainMax={100} />
        </div>
        {!target.capabilities.includes("hypervisor") ? (
          <div className="grid gap-3 lg:grid-cols-2">
            {target.capabilities.includes("load") ? (
              <MultiSeriesChart
                points={points}
                title="Load average"
                series={[
                  { name: "1m", color: "#10b981", valueOf: (p) => loadAt(p, "one") },
                  { name: "5m", color: "#0ea5e9", valueOf: (p) => loadAt(p, "five") },
                  { name: "15m", color: "#a78bfa", valueOf: (p) => loadAt(p, "fifteen") },
                ]}
              />
            ) : null}
            {showTemp ? (
              <MultiSeriesChart
                points={points}
                title="Temperature"
                format={(v) => `${Math.round(v)}°`}
                series={[{ name: "temp", color: "#f97316", valueOf: tempAt }]}
              />
            ) : null}
            <MultiSeriesChart
              points={points}
              title="Network throughput (recent)"
              format={(v) => formatBps(v)}
              series={[
                { name: "Rx", color: "#0ea5e9", valueOf: (p) => flowAgg(p, "interfaces", "rxBytesPerSec") },
                { name: "Tx", color: "#f59e0b", valueOf: (p) => flowAgg(p, "interfaces", "txBytesPerSec") },
              ]}
            />
            <MultiSeriesChart
              points={points}
              title="Disk I/O (recent)"
              format={(v) => formatBps(v)}
              series={[
                { name: "read", color: "#10b981", valueOf: (p) => flowAgg(p, "disks", "readBytesPerSec") },
                { name: "write", color: "#ef4444", valueOf: (p) => flowAgg(p, "disks", "writeBytesPerSec") },
              ]}
            />
          </div>
        ) : null}
      </section>

      {/* Capability-specific current detail */}
      {target.capabilities.includes("hypervisor") ? (
        <ProxmoxDetail entities={entities} metrics={sampleMetrics} />
      ) : (
        <>
          <LinuxDetail
            metrics={sampleMetrics}
            target={target}
            updateRuns={updateRuns}
            onRunUpdates={() => {
              setRunErr(null);
              setRunModalOpen(true);
            }}
            checkingUpdates={checkingUpdates}
            onCheckForUpdates={() => void checkForUpdates()}
            showTemp={showTemp}
            onToggleIgnoredMount={toggleIgnoredMount}
            onAddWatchedService={addWatchedService}
            onRemoveWatchedService={removeWatchedService}
          />
          {target.capabilities.includes("docker") ? <DockerDetail entities={entities} /> : null}
        </>
      )}

      {runModalOpen ? (
        <RunUpdatesModal
          targetName={target.name}
          busy={starting}
          err={runErr}
          onCancel={() => setRunModalOpen(false)}
          onConfirm={(reboot, fullUpgrade, includePhased) => void startRun(reboot, fullUpgrade, includePhased)}
        />
      ) : null}

      {/* Incidents */}
      <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Alert history</h2>
        {incidents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No alerts recorded.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 text-xs dark:divide-slate-800">
            {incidents.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                {i.resolvedAt ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-500" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {i.resolvedAt ? "Resolved" : "Open"}
                    {i.reason ? ` — ${i.reason}` : ""}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    started {new Date(i.startedAt).toLocaleString()}
                    {i.resolvedAt ? ` · resolved ${new Date(i.resolvedAt).toLocaleString()}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Danger zone */}
      <section className="flex items-center justify-between rounded-md border border-rose-200 p-4 text-xs dark:border-rose-900/50">
        <div>
          <div className="text-sm font-medium text-rose-700 dark:text-rose-300">Delete target</div>
          <div className="text-rose-600/80 dark:text-rose-400/80">
            Removes the target, its credentials, and all metrics history.
          </div>
        </div>
        <button
          type="button"
          onClick={destroy}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
        >
          <Trash2 className="h-4 w-4" aria-hidden /> Delete
        </button>
      </section>
      {err ? <p className="text-rose-600 dark:text-rose-400">{err}</p> : null}
    </div>
  );
}

function LinuxDetail({
  metrics,
  target,
  updateRuns,
  onRunUpdates,
  checkingUpdates,
  onCheckForUpdates,
  showTemp,
  onToggleIgnoredMount,
  onAddWatchedService,
  onRemoveWatchedService,
}: {
  metrics: Rec | null;
  target: InfraTarget;
  updateRuns: InfraUpdateRun[];
  onRunUpdates: () => void;
  checkingUpdates: boolean;
  onCheckForUpdates: () => void;
  showTemp: boolean;
  onToggleIgnoredMount: (mount: string, ignore: boolean) => void;
  onAddWatchedService: (name: string) => void;
  onRemoveWatchedService: (name: string) => void;
}) {
  const fs = (metrics?.filesystems as Array<Rec> | undefined) ?? [];
  const ifaces = (metrics?.interfaces as Array<Rec> | undefined) ?? [];
  const svc = (metrics?.services as Array<Rec> | undefined) ?? [];
  const load = (metrics?.load as Rec | undefined) ?? {};
  const updates = (metrics?.updates as Rec | undefined) ?? null;
  // The read-only check covers mac/windows too; "Run updates now" (a write)
  // is Linux-only — see infra-updater.ts.
  const canCheck = target.capabilities.includes("updates");
  const canRun = target.os === "linux" && canCheck;
  return (
    <>
      <section className={`grid gap-3 ${showTemp ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
        <Stat label="Load (1m)" value={num(load, "one") ?? "—"} />
        <Stat label="Uptime" value={formatUptime(num(metrics, "uptimeSec"))} />
        <Stat label="Processes" value={num(metrics, "processes") ?? "—"} />
        {showTemp ? (
          <Stat
            label="Temp"
            value={num(metrics, "temperatureC") !== null ? `${Math.round(num(metrics, "temperatureC")!)}°C` : "—"}
          />
        ) : null}
      </section>
      <UpdatesCard
        updates={updates}
        canCheck={canCheck}
        canRun={canRun}
        runs={updateRuns}
        onRunUpdates={onRunUpdates}
        checking={checkingUpdates}
        onCheckForUpdates={onCheckForUpdates}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        <FilesystemsCard
          fs={fs}
          ignoredMounts={(target.options.ignoredMounts as string[] | undefined) ?? []}
          onToggleIgnore={onToggleIgnoredMount}
        />
        <InterfacesCard ifaces={ifaces} />
        {target.capabilities.includes("services") ? (
          <ServicesCard
            targetId={target.id}
            watched={(target.options.watchedServices as string[] | undefined) ?? []}
            services={svc}
            onAdd={onAddWatchedService}
            onRemove={onRemoveWatchedService}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * Silent (returns null) when the host neither has data nor the ability to
 * check for/run updates — most targets, unless the `updates` capability is
 * on — so staying quiet here, rather than an empty-state card, keeps the
 * common case tidy.
 */
function UpdatesCard({
  updates,
  canCheck,
  canRun,
  runs,
  onRunUpdates,
  checking,
  onCheckForUpdates,
}: {
  updates: Rec | null;
  canCheck: boolean;
  canRun: boolean;
  runs: InfraUpdateRun[];
  onRunUpdates: () => void;
  checking: boolean;
  onCheckForUpdates: () => void;
}) {
  if (!updates && !canCheck) return null;
  const count = updates ? num(updates, "count") : null;
  const securityCount = updates ? num(updates, "securityCount") : null;
  const rebootRequired = updates ? num(updates, "rebootRequired") === 1 : false;
  const packageManager = updates && typeof updates.packageManager === "string" ? updates.packageManager : null;
  const running = runs.some((r) => r.status === "running");

  const action = (
    <div className="flex shrink-0 items-center gap-1.5">
      {canCheck ? (
        <button
          type="button"
          onClick={onCheckForUpdates}
          disabled={checking}
          title="Check for updates now"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-900"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
          {checking ? "Checking…" : "Check now"}
        </button>
      ) : null}
      {canRun ? (
        <button
          type="button"
          onClick={onRunUpdates}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="h-3.5 w-3.5" aria-hidden />
          )}
          {running ? "Running…" : "Run updates"}
        </button>
      ) : null}
    </div>
  );

  return (
    <Card title="OS updates" action={action}>
      {!updates ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">No data yet.</p>
      ) : count === null ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Couldn&apos;t determine — check the package manager is reachable over SSH.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            {count > 0 ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
            ) : (
              <CircleCheck className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
            )}
            <span className="text-sm font-medium">
              {count === 0 ? "Up to date" : `${count} update${count === 1 ? "" : "s"} available`}
            </span>
          </div>
          {securityCount !== null && securityCount > 0 ? (
            <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
              {securityCount} security
            </span>
          ) : null}
          {rebootRequired ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              Reboot required
            </span>
          ) : null}
          {packageManager ? (
            <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">via {packageManager}</span>
          ) : null}
        </div>
      )}
      {runs.length ? <UpdateRunHistory runs={runs} /> : null}
    </Card>
  );
}

/** Last few "run updates" attempts — status, when, reboot outcome, expandable log. */
function UpdateRunHistory({ runs }: { runs: InfraUpdateRun[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul className="mt-3 space-y-1 border-t border-slate-200 pt-2 dark:border-slate-800">
      {runs.slice(0, 5).map((r) => {
        const isOpen = openId === r.id;
        const hasLog = Boolean(r.output || r.error);
        return (
          <li key={r.id} className="text-xs">
            <button
              type="button"
              onClick={() => hasLog && setOpenId(isOpen ? null : r.id)}
              className={`flex w-full items-center gap-2 rounded px-1 py-1 text-left ${
                hasLog ? "hover:bg-slate-50 dark:hover:bg-slate-900" : "cursor-default"
              }`}
            >
              <RunStatusIcon status={r.status} />
              <span className="text-slate-600 dark:text-slate-400">
                {new Date(r.startedAt).toLocaleString()}
                {r.triggeredByName ? ` · ${r.triggeredByName}` : ""}
              </span>
              {r.packageManager ? (
                <span className="text-slate-400 dark:text-slate-500">via {r.packageManager}</span>
              ) : null}
              {r.fullUpgrade ? (
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  full upgrade
                </span>
              ) : null}
              {r.includePhased ? (
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  incl. phased
                </span>
              ) : null}
              {r.rebootTriggered ? (
                <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
                  rebooted
                </span>
              ) : null}
              <span className="ml-auto capitalize text-slate-400 dark:text-slate-500">
                {r.status.replace("_", " ")}
              </span>
            </button>
            {isOpen ? (
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-2 text-[11px] text-slate-100">
                {r.error ? `${r.error}\n\n` : ""}
                {r.output ?? ""}
              </pre>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function RunStatusIcon({ status }: { status: InfraUpdateRun["status"] }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-brand-600" aria-hidden />;
  if (status === "success") return <CircleCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />;
  return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-500" aria-hidden />;
}

function RunUpdatesModal({
  targetName,
  busy,
  err,
  onCancel,
  onConfirm,
}: {
  targetName: string;
  busy: boolean;
  err: string | null;
  onCancel: () => void;
  onConfirm: (reboot: boolean, fullUpgrade: boolean, includePhased: boolean) => void;
}) {
  const [reboot, setReboot] = useState(true);
  const [fullUpgrade, setFullUpgrade] = useState(false);
  const [includePhased, setIncludePhased] = useState(false);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onCancel()}
    >
      <div
        className="w-full max-w-md rounded-lg border border-slate-300 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">Run updates on {targetName}?</h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          This installs the host&apos;s pending package updates over SSH. It can take several minutes and touches a
          live host — make sure that&apos;s expected right now.
        </p>
        <label className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 p-2.5 text-sm dark:border-slate-800">
          <input
            type="checkbox"
            checked={reboot}
            onChange={(e) => setReboot(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
          />
          <span>
            <span className="block font-medium">Reboot after updating, if required</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Only reboots if the host still flags one as needed once the upgrade finishes (e.g. a kernel update).
              Leave unchecked to apply updates without ever rebooting.
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 rounded-md border border-slate-200 p-2.5 text-sm dark:border-slate-800">
          <input
            type="checkbox"
            checked={fullUpgrade}
            onChange={(e) => setFullUpgrade(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
          />
          <span>
            <span className="block font-medium">Full upgrade (apt only)</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Plain upgrade never removes a package, so kernel/dependency-driven updates often show as
              &quot;kept back&quot; forever. This pulls those in too — it can add or remove packages as a side
              effect of resolving dependencies.
            </span>
          </span>
        </label>
        <label className="mt-2 flex items-start gap-2 rounded-md border border-slate-200 p-2.5 text-sm dark:border-slate-800">
          <input
            type="checkbox"
            checked={includePhased}
            onChange={(e) => setIncludePhased(e.target.checked)}
            disabled={busy}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-900"
          />
          <span>
            <span className="block font-medium">Include phased updates (apt only)</span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              Ubuntu/Debian stage some package versions out to a percentage of machines at a time to catch
              regressions early, and apt correctly defers those (&quot;deferred due to phasing&quot;) until your
              turn comes up. This installs them right away instead of waiting.
            </span>
          </span>
        </label>
        {err ? <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reboot, fullUpgrade, includePhased)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {busy ? "Starting…" : "Run updates"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Filesystems, fullest first, capped with an expand toggle — same treatment as
 * the interfaces card, since hosts with many mounts (bind mounts, snaps, ZFS
 * datasets) otherwise make this list run long.
 */
const FS_VISIBLE = 5;

function FilesystemsCard({
  fs,
  ignoredMounts,
  onToggleIgnore,
}: {
  fs: Rec[];
  ignoredMounts: string[];
  onToggleIgnore: (mount: string, ignore: boolean) => void;
}) {
  const canWrite = useCanWrite();
  const [expanded, setExpanded] = useState(false);
  const sorted = [...fs].sort((a, b) => (num(b, "pct") ?? 0) - (num(a, "pct") ?? 0));
  const hidden = Math.max(0, sorted.length - FS_VISIBLE);
  const shown = expanded ? sorted : sorted.slice(0, FS_VISIBLE);
  return (
    <Card title={`Filesystems${fs.length ? ` (${fs.length})` : ""}`}>
      {fs.length === 0 ? (
        <Empty />
      ) : (
        <>
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col />
              <col className="w-32" />
              <col className="w-28" />
              <col className="w-16" />
            </colgroup>
            <tbody>
              {shown.map((f, i) => {
                const mount = String(f.mount);
                // Source of truth is the persisted config, not the per-poll `ignored`
                // flag on the sample (which only reflects it after the next poll).
                const ignored = ignoredMounts.includes(mount);
                return (
                  <tr
                    key={i}
                    className={`border-t border-slate-100 dark:border-slate-800 ${ignored ? "opacity-50" : ""}`}
                  >
                    <td className="truncate py-1.5 pr-2 font-mono" title={mount}>
                      {mount}
                    </td>
                    <td className="py-1.5 text-right text-slate-500">
                      {formatBytes(num(f, "usedBytes"))} / {formatBytes(num(f, "sizeBytes"))}
                    </td>
                    <td className="py-1.5 pl-3">
                      <Gauge label="" pct={num(f, "pct")} />
                    </td>
                    <td className="py-1.5 pl-2 text-right">
                      {canWrite ? (
                        <button
                          type="button"
                          onClick={() => onToggleIgnore(mount, !ignored)}
                          role="switch"
                          aria-checked={!ignored}
                          aria-label={`Alert on ${mount}`}
                          title={
                            ignored
                              ? `${mount} is excluded from disk alerting/reporting — click to re-include`
                              : `${mount} counts toward disk alerting/reporting — click to ignore`
                          }
                          className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                            ignored ? "bg-slate-300 dark:bg-slate-700" : "bg-emerald-500"
                          }`}
                        >
                          <span
                            className={`inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ${
                              ignored ? "translate-x-0.5" : "translate-x-3.5"
                            }`}
                          />
                        </button>
                      ) : ignored ? (
                        <span className="text-[10px] font-medium text-slate-500">Ignored</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {expanded ? "Show fewer" : `Show all ${sorted.length} filesystems`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

/**
 * Watched systemd units / Windows services for this target, named by the
 * operator. `watched` (from target.options.watchedServices) is the source of
 * truth for which rows exist; `services` (the last poll's sample) only
 * supplies each row's live status — a name just added shows "pending" until
 * the next poll. Rows can be added either by typing an exact name or via
 * "Discover" (a live SSH probe listing everything on the host to pick from).
 */
function ServicesCard({
  targetId,
  watched,
  services,
  onAdd,
  onRemove,
}: {
  targetId: string;
  watched: string[];
  services: Rec[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
}) {
  const canWrite = useCanWrite();
  const [draft, setDraft] = useState("");
  const [discovered, setDiscovered] = useState<InfraDiscoveredService[] | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverErr, setDiscoverErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const byName = new Map(services.map((s) => [String(s.name), s]));

  function submit(e: FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (name) onAdd(name);
    setDraft("");
  }

  async function discover() {
    setDiscovering(true);
    setDiscoverErr(null);
    try {
      const r = await fetch(`/api/infra/targets/${targetId}/discover-services`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        setDiscoverErr(Array.isArray(b.message) ? b.message.join(", ") : (b.message ?? `Failed (${r.status})`));
        return;
      }
      const body = (await r.json()) as InfraDiscoveredService[];
      setDiscovered(body.sort((a, b) => a.name.localeCompare(b.name)));
    } catch {
      setDiscoverErr("Failed to reach host");
    } finally {
      setDiscovering(false);
    }
  }

  const filtered = (discovered ?? []).filter((s) => s.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <Card title={`Services${watched.length ? ` (${watched.length})` : ""}`}>
      {watched.length === 0 ? (
        <Empty />
      ) : (
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col />
            <col className="w-24" />
            <col className="w-8" />
          </colgroup>
          <tbody>
            {watched.map((name) => {
              const row = byName.get(name);
              const active = row?.active === true;
              const status = row ? String(row.status) : "pending";
              return (
                <tr key={name} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="truncate py-1.5 pr-2 font-mono" title={name}>
                    {name}
                  </td>
                  <td className="py-1.5 pr-2">
                    <span
                      className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${
                        active
                          ? "text-emerald-600 dark:text-emerald-400"
                          : row
                            ? "text-rose-600 dark:text-rose-400"
                            : "text-slate-500 dark:text-slate-400"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          active ? "bg-emerald-500" : row ? "bg-rose-500" : "bg-slate-400"
                        }`}
                      />
                      {status}
                    </span>
                  </td>
                  <td className="py-1.5 text-right">
                    {canWrite ? (
                      <button
                        type="button"
                        onClick={() => onRemove(name)}
                        title={`Stop watching ${name}`}
                        className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {canWrite ? (
        <div className="mt-2 space-y-2">
          <form onSubmit={submit} className="flex gap-1.5">
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Service name (e.g. nginx)"
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
            />
            <button
              type="submit"
              className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900"
            >
              Add
            </button>
          </form>
          <button
            type="button"
            onClick={() => void discover()}
            disabled={discovering}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:underline disabled:opacity-60 dark:text-brand-400"
          >
            {discovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {discovering ? "Reading services from host…" : discovered ? "Refresh from host" : "Discover services on this host"}
          </button>
          {discoverErr ? <p className="text-[11px] text-rose-600 dark:text-rose-400">{discoverErr}</p> : null}
          {discovered ? (
            discovered.length === 0 ? (
              <p className="text-[11px] text-slate-500 dark:text-slate-400">Host reported no services.</p>
            ) : (
              <div className="rounded-md border border-slate-200 dark:border-slate-800">
                <input
                  type="text"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={`Filter ${discovered.length} services…`}
                  className="w-full border-b border-slate-200 bg-transparent px-2 py-1 text-xs dark:border-slate-800"
                />
                <div className="max-h-48 overflow-y-auto">
                  {filtered.length === 0 ? (
                    <p className="px-2 py-1.5 text-[11px] text-slate-500 dark:text-slate-400">No matches.</p>
                  ) : (
                    filtered.map((s) => {
                      const already = watched.includes(s.name);
                      return (
                        <div
                          key={s.name}
                          className="flex items-center justify-between gap-2 border-t border-slate-100 px-2 py-1 text-xs first:border-t-0 dark:border-slate-800"
                        >
                          <span className="truncate font-mono" title={s.name}>
                            {s.name}
                          </span>
                          <span
                            className={`shrink-0 text-[10px] ${
                              s.active ? "text-emerald-600 dark:text-emerald-400" : "text-slate-500 dark:text-slate-400"
                            }`}
                          >
                            {s.status}
                          </span>
                          <button
                            type="button"
                            onClick={() => onAdd(s.name)}
                            disabled={already}
                            className="shrink-0 rounded border border-slate-300 px-1.5 py-0.5 text-[10px] font-medium hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-900"
                          >
                            {already ? "Added" : "Add"}
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Network interfaces, busiest first, capped to a handful with an expand toggle.
 * Docker/bridged hosts surface dozens of virtual (veth / bridge) interfaces,
 * which otherwise make this card taller than everything else on the page.
 */
const IFACE_VISIBLE = 5;

function InterfacesCard({ ifaces }: { ifaces: Rec[] }) {
  const [expanded, setExpanded] = useState(false);
  // Sort by throughput (rx+tx per sec) so the interfaces that matter lead.
  const sorted = [...ifaces].sort(
    (a, b) =>
      ((num(b, "rxBytesPerSec") ?? 0) + (num(b, "txBytesPerSec") ?? 0)) -
      ((num(a, "rxBytesPerSec") ?? 0) + (num(a, "txBytesPerSec") ?? 0)),
  );
  const hidden = Math.max(0, sorted.length - IFACE_VISIBLE);
  const shown = expanded ? sorted : sorted.slice(0, IFACE_VISIBLE);
  return (
    <Card title={`Network interfaces${ifaces.length ? ` (${ifaces.length})` : ""}`}>
      {ifaces.length === 0 ? (
        <Empty />
      ) : (
        <>
          <table className="w-full table-fixed text-xs">
            <colgroup>
              <col />
              <col className="w-24" />
              <col className="w-24" />
            </colgroup>
            <thead>
              <tr className="text-left text-slate-400">
                <th className="py-1 font-medium">Interface</th>
                <th className="py-1 text-right font-medium">↓ Rx</th>
                <th className="py-1 text-right font-medium">↑ Tx</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((n, i) => (
                <tr key={i} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="truncate py-1.5 pr-2 font-mono">{String(n.iface)}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatBps(num(n, "rxBytesPerSec"))}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatBps(num(n, "txBytesPerSec"))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-2 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              {expanded ? "Show fewer" : `Show all ${sorted.length} interfaces`}
            </button>
          ) : null}
        </>
      )}
    </Card>
  );
}

function DockerDetail({ entities }: { entities: InfraEntity[] }) {
  const containers = entities.filter((e) => e.entityKind === "container");
  // Group by compose project (groupKey); ungrouped last.
  const groups = new Map<string, InfraEntity[]>();
  for (const c of containers) {
    const key = c.groupKey ?? "(standalone)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return (
    <Card title={`Containers (${containers.length})`}>
      {containers.length === 0 ? (
        <Empty />
      ) : (
        // One fixed-layout table so every compose group shares the same column
        // widths; projects are section-header rows rather than separate tables
        // (which each sized their columns independently and never lined up).
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col />
            <col className="w-28" />
            <col className="w-16" />
            <col className="w-24" />
          </colgroup>
          <thead>
            <tr className="text-left text-slate-400">
              <th className="py-1 font-medium">Container</th>
              <th className="py-1 font-medium">State</th>
              <th className="py-1 text-right font-medium">CPU</th>
              <th className="py-1 text-right font-medium">Memory</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([project, list]) => (
              <Fragment key={project}>
                <tr>
                  <td colSpan={4} className="pt-3 pb-0.5 text-[11px] font-semibold text-slate-500">
                    {project}
                  </td>
                </tr>
                {list.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-2">
                      <div className="truncate font-medium">{c.name}</div>
                      <div className="truncate font-mono text-[10px] text-slate-400">
                        {String(c.state.image ?? "")}
                      </div>
                    </td>
                    <td className="py-1.5">
                      <ContainerState status={c.status} health={c.health} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {num(c.state, "cpuPct") !== null ? `${num(c.state, "cpuPct")}%` : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatBytes(num(c.state, "memUsedBytes"))}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ProxmoxDetail({ entities, metrics }: { entities: InfraEntity[]; metrics: Rec | null }) {
  const nodes = entities.filter((e) => e.entityKind === "node");
  const guests = entities.filter((e) => e.entityKind === "guest");
  const storage = entities.filter((e) => e.entityKind === "storage");
  const quorate = (metrics?.quorate as boolean | null | undefined) ?? null;
  return (
    <>
      {quorate !== null ? (
        <div className="text-xs">
          Cluster quorum:{" "}
          <span className={quorate ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
            {quorate ? "quorate" : "no quorum"}
          </span>
        </div>
      ) : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title={`Nodes (${nodes.length})`}>
          {nodes.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 font-medium">Node</th>
                  <th className="py-1 text-right font-medium">CPU</th>
                  <th className="py-1 text-right font-medium">Mem</th>
                  <th className="py-1 text-right font-medium">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 font-medium">{n.name}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtPct(num(n.state, "cpuPct"))}</td>
                    <td className="py-1.5 text-right tabular-nums">{fmtPct(num(n.state, "memPct"))}</td>
                    <td className="py-1.5 text-right">{formatUptime(num(n.state, "uptimeSec"))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title={`Guests (${guests.length})`}>
          {guests.length === 0 ? (
            <Empty />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="py-1 font-medium">Guest</th>
                  <th className="py-1 font-medium">Type</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 text-right font-medium">CPU</th>
                </tr>
              </thead>
              <tbody>
                {guests.map((g) => (
                  <tr key={g.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 font-medium">{g.name}</td>
                    <td className="py-1.5 uppercase text-slate-400">{String(g.state.guestType ?? "")}</td>
                    <td className="py-1.5">
                      <ContainerState status={g.status} health={null} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {g.status === "running" ? fmtPct(num(g.state, "cpuPct")) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      {storage.length > 0 ? (
        <Card title="Storage pools">
          <div className="space-y-2">
            {storage.map((s) => (
              <div key={s.id}>
                <Gauge label={s.name} pct={num(s.state, "usedPct")} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

function ContainerState({ status, health }: { status: string; health: string | null }) {
  const down = status !== "running";
  const bad = health === "unhealthy";
  const cls = bad
    ? "text-rose-600 dark:text-rose-400"
    : down
      ? "text-slate-500"
      : "text-emerald-600 dark:text-emerald-400";
  return (
    <span className={cls}>
      {status}
      {health ? ` · ${health}` : ""}
    </span>
  );
}

function Card({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-md border border-slate-300 p-4 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Empty() {
  return <p className="text-xs text-slate-500 dark:text-slate-400">No data yet.</p>;
}

function fmtPct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v)}%`;
}
