"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, CircleCheck, Pencil, Power, RefreshCw, Trash2 } from "lucide-react";
import type { InfraMetricPoint, ServiceInstance, ServiceSeriesPoint, ServiceTemplate } from "@church/shared";
import { GoneNotice } from "@/components/gone-notice";
import { usePoll } from "@/lib/use-poll";
import { ToastStack, cardCls, useCanWrite, useToasts } from "../../../../network-cisco/cisco-ui";
import { AcknowledgeButton } from "../../../../acknowledge-button";
import { MultiSeriesChart } from "../../../charts";
import {
  ConfirmCommandsBox,
  ConfirmCommandsNeeded,
  ServiceFormModal,
  ServiceStatusPill,
  ValueGrid,
  ago,
  btnCls,
  cardKeys,
  formatMetric,
  metricLabel,
  svcGet,
  svcSend,
} from "../../../services/services-ui";

const RANGES = [
  { key: "6h", label: "6h", ms: 6 * 3_600_000 },
  { key: "24h", label: "24h", ms: 24 * 3_600_000 },
  { key: "7d", label: "7d", ms: 7 * 86_400_000 },
  { key: "30d", label: "30d", ms: 30 * 86_400_000 },
] as const;

const COLORS = ["#10b981", "#0ea5e9", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b"];

interface Incident {
  id: string;
  ruleId: string | null;
  reason: string | null;
  startedAt: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
}

/** The chart helpers take infra points; a service point carries its values under `values`. */
const valuesOf = (p: InfraMetricPoint) => (p as unknown as ServiceSeriesPoint).values;

export function ServiceInstanceClient({ targetId, id }: { targetId: string; id: string }) {
  const router = useRouter();
  const canWrite = useCanWrite();
  const [s, setS] = useState<ServiceInstance | null>(null);
  const [template, setTemplate] = useState<ServiceTemplate | null>(null);
  const [gone, setGone] = useState(false);
  const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("6h");
  const [points, setPoints] = useState<ServiceSeriesPoint[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [editing, setEditing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [enableCommands, setEnableCommands] = useState<string[] | null>(null);
  const [enableConfirmed, setEnableConfirmed] = useState(false);
  const { toasts, show, dismiss } = useToasts();
  // The template is read once (a ref, so reading it does not re-create `load` and fetch twice).
  const templateRef = useRef<ServiceTemplate | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/service-monitoring/instances/${id}`, { credentials: "same-origin", cache: "no-store" }).catch(() => null);
    if (r && (r.status === 404 || r.status === 400)) return setGone(true);
    if (!r?.ok) return;
    const inst = (await r.json()) as ServiceInstance;
    setS(inst);
    const ms = RANGES.find((x) => x.key === range)!.ms;
    const from = new Date(Date.now() - ms).toISOString();
    const [series, inc, tpl] = await Promise.all([
      svcGet<{ points: ServiceSeriesPoint[] }>(`/instances/${id}/series?from=${encodeURIComponent(from)}`),
      svcGet<Incident[]>(`/instances/${id}/incidents`),
      templateRef.current?.key === inst.templateKey ? Promise.resolve(null) : svcGet<ServiceTemplate>(`/templates/${encodeURIComponent(inst.templateKey)}`),
    ]);
    if (series) setPoints(series.points);
    if (inc) setIncidents(inc);
    if (tpl) {
      templateRef.current = tpl;
      setTemplate(tpl);
    }
  }, [id, range]);
  usePoll(load, 20_000);

  async function checkNow() {
    setChecking(true);
    try {
      setS(await svcSend<ServiceInstance>(`/instances/${id}/poll-now`, "POST"));
      show(true, "Checked.");
      void load();
    } catch (e) {
      show(false, (e as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function setEnabled(enabled: boolean, confirmCommands?: string[]) {
    try {
      setS(await svcSend<ServiceInstance>(`/instances/${id}`, "PATCH", { enabled, confirmCommands }));
      setEnableCommands(null);
      show(true, enabled ? "Switched on." : "Switched off: its open alerts are closed.");
    } catch (e) {
      if (e instanceof ConfirmCommandsNeeded) {
        setEnableConfirmed(false);
        setEnableCommands(e.commands);
      } else show(false, (e as Error).message);
    }
  }

  async function remove() {
    if (!s || !window.confirm(`Stop watching ${s.name}? Its readings go too.`)) return;
    try {
      await svcSend(`/instances/${id}`, "DELETE");
      router.push(`/monitoring/infra/${targetId}`);
    } catch (e) {
      show(false, (e as Error).message);
    }
  }

  if (gone) return <GoneNotice what="service" backHref={`/monitoring/infra/${targetId}`} backLabel="Back to the host" />;
  if (!s) return <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>;
  const body = template?.body ?? null;
  const keys = cardKeys(body, s.values, s.states);
  const charts =
    body?.display?.charts ??
    Object.entries(body?.metrics ?? {})
      .filter(([, m]) => m.kind !== "state")
      .slice(0, 4)
      .map(([k, m]) => ({ title: metricLabel(k, m), metrics: [k] }));
  const memberCols = Object.keys(body?.members?.columns ?? {});
  const chartPoints = points as unknown as InfraMetricPoint[];

  return (
    <div className="space-y-6">
      <Link href={`/monitoring/infra/${targetId}`} className="inline-flex items-center gap-1 text-sm text-brand-600 hover:underline dark:text-brand-400">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {s.targetName}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold">
            {s.name} <ServiceStatusPill status={s.status} />
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {s.templateName} on {s.targetName} · every {s.intervalSec} s · checked {ago(s.lastPolledAt)}
            {s.runsCommands ? " · runs commands over SSH" : ""}
          </p>
        </div>
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void checkNow()} disabled={checking || !s.enabled} className={btnCls}>
              <RefreshCw className={`h-4 w-4 ${checking ? "motion-safe:animate-spin" : ""}`} aria-hidden /> {checking ? "Checking…" : "Check now"}
            </button>
            <button onClick={() => setEditing(true)} className={btnCls}>
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </button>
            <button onClick={() => void setEnabled(!s.enabled)} className={btnCls} aria-pressed={s.enabled}>
              <Power className="h-4 w-4" aria-hidden /> {s.enabled ? "Switch off" : "Switch on"}
            </button>
            <button onClick={() => void remove()} className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950">
              <Trash2 className="h-4 w-4" aria-hidden /> Delete
            </button>
          </div>
        ) : null}
      </div>

      {enableCommands ? (
        <div className="space-y-2">
          <ConfirmCommandsBox commands={enableCommands} checked={enableConfirmed} onChange={setEnableConfirmed} />
          <div className="flex gap-2">
            <button className={btnCls} disabled={!enableConfirmed} onClick={() => void setEnabled(true, enableCommands)}>
              Switch on
            </button>
            <button className={btnCls} onClick={() => setEnableCommands(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {s.lastError ? <p className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">{s.lastError}</p> : null}
      {Object.keys(s.collectorErrors).length ? (
        <ul className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200" aria-label="Readings that failed">
          {Object.entries(s.collectorErrors).map(([k, e]) => (
            <li key={k}>
              <span className="font-medium">{k}</span>: {e}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {keys.map((k) => (
          <div key={k} className={cardCls}>
            <p className="text-xs text-slate-500 dark:text-slate-400">{metricLabel(k, body?.metrics[k])}</p>
            <p className="mt-1 font-mono text-lg">{k in s.states ? (s.states[k] ?? "-") : formatMetric(s.values[k], body?.metrics[k])}</p>
          </div>
        ))}
      </div>

      <section className={cardCls} aria-labelledby="svc-checks">
        <h2 id="svc-checks" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Checks
        </h2>
        {s.checks.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">This template has no checks.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {s.checks.map((c) => (
              <li key={c.id} className="flex items-start gap-2">
                {c.breaching ? (
                  <AlertTriangle className={`mt-0.5 h-4 w-4 shrink-0 ${c.severity === "critical" ? "text-rose-600 dark:text-rose-400" : "text-amber-700 dark:text-amber-400"}`} aria-hidden />
                ) : (
                  <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
                )}
                <span>
                  <span className="font-medium">{c.id}</span> <span className="text-slate-500 dark:text-slate-400">({c.severity})</span>:{" "}
                  {c.breaching ? c.text : "fine"}
                  {c.breaching && !c.open ? <span className="text-slate-500 dark:text-slate-400"> (waiting for it to last)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-labelledby="svc-history">
        <div className="flex items-center gap-3">
          <h2 id="svc-history" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            History
          </h2>
          <div className="ml-auto flex gap-1" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                aria-pressed={range === r.key}
                className={`rounded px-2 py-0.5 text-xs ${range === r.key ? "bg-brand-600 text-white" : "border border-slate-300 dark:border-slate-700"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {charts.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {charts.map((c) => (
              <MultiSeriesChart
                key={c.title}
                title={c.title}
                points={chartPoints}
                format={(v) => formatMetric(v, body?.metrics[c.metrics[0]!])}
                series={c.metrics.map((k, i) => ({ name: metricLabel(k, body?.metrics[k]), color: COLORS[i % COLORS.length]!, valueOf: (p) => valuesOf(p)[k] ?? null }))}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">Nothing to chart.</p>
        )}
      </section>

      {s.members.length ? (
        <section className={cardCls} aria-labelledby="svc-members">
          <h2 id="svc-members" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {body?.members?.label ?? "Members"} ({s.members.length}
            {s.membersOmitted ? ` shown, ${s.membersOmitted} more not kept` : ""})
          </h2>
          <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Members">
            <table className="w-full text-left text-xs">
              <thead className="text-slate-500 dark:text-slate-400">
                <tr>
                  <th className="py-1 pr-3 font-medium">Name</th>
                  <th className="py-1 pr-3 font-medium">Healthy</th>
                  {memberCols.map((c) => (
                    <th key={c} className="py-1 pr-3 font-medium">
                      {c.replace(/_/g, " ")}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {s.members.map((m) => (
                  <tr key={m.key}>
                    <td className="py-1 pr-3 font-medium">{m.name}</td>
                    <td className="py-1 pr-3">
                      {m.ok === null ? "-" : m.ok ? <span className="text-emerald-700 dark:text-emerald-400">yes</span> : <span className="font-medium text-rose-700 dark:text-rose-300">no</span>}
                    </td>
                    {memberCols.map((c) => (
                      <td key={c} className="py-1 pr-3 font-mono">
                        {m.columns[c] === null || m.columns[c] === undefined ? "-" : String(m.columns[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <details className={cardCls}>
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Every value</summary>
        <div className="mt-2">
          <ValueGrid body={body} values={s.values} states={s.states} />
        </div>
      </details>

      <section className={cardCls} aria-labelledby="svc-incidents">
        <h2 id="svc-incidents" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Alert history
        </h2>
        {incidents.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">No alerts recorded.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-200 text-xs dark:divide-slate-800">
            {incidents.map((i) => (
              <li key={i.id} className="flex items-center gap-3 py-2">
                {i.resolvedAt ? (
                  <CircleCheck className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden />
                ) : (
                  <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {i.resolvedAt ? "Resolved" : "Open"}
                    {i.reason ? ` - ${i.reason}` : ""}
                  </div>
                  <div className="text-slate-500 dark:text-slate-400">
                    started {new Date(i.startedAt).toLocaleString()}
                    {i.resolvedAt ? `, resolved ${new Date(i.resolvedAt).toLocaleString()}` : ""}
                    {i.acknowledgedAt ? `, acknowledged ${new Date(i.acknowledgedAt).toLocaleString()}` : ""}
                  </div>
                </div>
                {canWrite && !i.resolvedAt && !i.acknowledgedAt ? (
                  <AcknowledgeButton incidentId={i.id} onAcknowledged={(at) => setIncidents((list) => list.map((x) => (x.id === i.id ? { ...x, acknowledgedAt: at } : x)))} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editing ? (
        <ServiceFormModal
          targetId={targetId}
          instance={s}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            setS(saved);
            show(true, "Saved.");
          }}
        />
      ) : null}
      <ToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
