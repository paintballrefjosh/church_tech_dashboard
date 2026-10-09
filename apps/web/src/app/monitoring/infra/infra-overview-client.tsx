"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Server as ServerIcon } from "lucide-react";
import type { InfraTarget, InfraSummary } from "@church/shared";
import { OS_META, capabilityLabels, StatusPill, Gauge } from "./infra-ui";
import { useRealtimeRoom } from "@/lib/use-realtime";

export function InfraOverviewClient({
  initialTargets,
  initialSummary,
}: {
  initialTargets: InfraTarget[];
  initialSummary: InfraSummary | null;
}) {
  const [targets, setTargets] = useState(initialTargets);
  const [summary, setSummary] = useState(initialSummary);

  const load = useCallback(async () => {
    try {
      const [t, s] = await Promise.all([
        fetch("/api/infra/targets", { credentials: "same-origin", cache: "no-store" }),
        fetch("/api/infra/summary", { credentials: "same-origin", cache: "no-store" }),
      ]);
      if (t.ok) setTargets((await t.json()) as InfraTarget[]);
      if (s.ok) setSummary((await s.json()) as InfraSummary);
    } catch {
      /* transient */
    }
  }, []);

  // The collector emits one `infra:update` per target per tick; coalesce a
  // burst into a single refetch so the up/degraded/down summary stays exact.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedLoad = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(), 300);
  }, [load]);

  const { connected } = useRealtimeRoom("infra", { "infra:update": debouncedLoad }, () => void load());

  // Fallback poll only while the socket is down.
  useEffect(() => {
    if (connected) return;
    const id = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 15_000);
    return () => clearInterval(id);
  }, [connected, load]);

  return (
    <div className="space-y-6">
      {summary ? (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryTile
            label="Targets up"
            value={`${summary.targets.up}/${summary.targets.total}`}
            tone="ok"
            sub={summary.targets.disabled ? `${summary.targets.disabled} disabled` : undefined}
          />
          <SummaryTile
            label="Down / degraded"
            value={`${summary.targets.down} / ${summary.targets.degraded}`}
            tone={summary.targets.down > 0 ? "bad" : summary.targets.degraded > 0 ? "warn" : "ok"}
          />
          <SummaryTile
            label="Containers running"
            value={`${summary.containers.running}/${summary.containers.total}`}
            tone={summary.containers.unhealthy > 0 ? "warn" : "ok"}
            sub={summary.containers.unhealthy > 0 ? `${summary.containers.unhealthy} unhealthy` : undefined}
          />
          <SummaryTile
            label="Open alerts"
            value={String(summary.openAlerts)}
            tone={summary.openAlerts > 0 ? "bad" : "ok"}
            sub={summary.guests.total > 0 ? `${summary.guests.running}/${summary.guests.total} VMs up` : undefined}
          />
          <SummaryTile
            label="Hosts with updates"
            value={String(summary.updates.hostsWithUpdates)}
            tone={
              summary.updates.hostsWithSecurityUpdates > 0
                ? "bad"
                : summary.updates.hostsWithUpdates > 0
                  ? "warn"
                  : "ok"
            }
            sub={
              summary.updates.hostsWithSecurityUpdates > 0
                ? `${summary.updates.hostsWithSecurityUpdates} with security updates`
                : summary.updates.hostsNeedingReboot > 0
                  ? `${summary.updates.hostsNeedingReboot} need a reboot`
                  : undefined
            }
          />
        </section>
      ) : null}

      {targets.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
          <ServerIcon className="mx-auto h-8 w-8 text-slate-400" aria-hidden />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">
            No infrastructure targets yet.{" "}
            <Link href="/monitoring/infra/new" className="text-brand-600 hover:underline">
              Add your first one
            </Link>
            .
          </p>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {targets.map((t) => (
            <TargetCard key={t.id} target={t} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TargetCard({ target }: { target: InfraTarget }) {
  const meta = OS_META[target.os];
  const caps = capabilityLabels(target.capabilities);
  const sample = target.lastSample as
    | {
        cpuPct?: number | null;
        memPct?: number | null;
        diskPctMax?: number | null;
        metrics?: { updates?: UpdatesMetric } | null;
      }
    | null;
  const updates = sample?.metrics?.updates ?? null;
  // Switched off: greyed out, and the last readings are not shown as if they were current.
  const off = !target.enabled;
  return (
    <li>
      <Link
        href={`/monitoring/infra/${target.id}`}
        aria-label={off ? `${target.name} (monitoring disabled)` : undefined}
        className={`block rounded-md border p-4 transition ${
          off
            ? "border-dashed border-slate-300 bg-slate-100/70 opacity-60 grayscale hover:opacity-90 dark:border-slate-700 dark:bg-slate-900/60"
            : "border-slate-300 hover:border-brand-400 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-900"
        }`}
      >
        <div className="flex items-center gap-2">
          <meta.Icon className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium">{target.name}</span>
          <StatusPill status={target.status} enabled={target.enabled} />
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-slate-500">
          {meta.label} · {target.host}
        </div>
        {caps.length ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {caps.map((c) => (
              <span
                key={c}
                className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {c}
              </span>
            ))}
          </div>
        ) : null}
        {off ? (
          <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
            Monitoring is switched off: this host is not being polled and raises no alerts.
          </p>
        ) : (
          <>
            <UpdatesBadge updates={updates} />
            <div className="mt-3 space-y-2">
              <Gauge label="CPU" pct={sample?.cpuPct ?? null} />
              <Gauge label="Memory" pct={sample?.memPct ?? null} />
              <Gauge label="Disk (max)" pct={sample?.diskPctMax ?? null} />
            </div>
          </>
        )}
        {!off && target.lastError ? (
          <div className="mt-2 truncate text-xs text-rose-600 dark:text-rose-400" title={target.lastError}>
            {target.lastError}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

type UpdatesMetric = {
  count?: number | null;
  securityCount?: number | null;
  rebootRequired?: number | null;
};

/**
 * Silent when the `updates` capability is off, not yet polled, or fully
 * up to date — only surfaces when there's something for the operator to act
 * on, same "don't clutter the common case" rule as the detail page's card.
 */
function UpdatesBadge({ updates }: { updates: UpdatesMetric | null }) {
  if (!updates) return null;
  const count = typeof updates.count === "number" ? updates.count : null;
  const securityCount = typeof updates.securityCount === "number" ? updates.securityCount : null;
  const rebootRequired = updates.rebootRequired === 1;
  if ((count === null || count <= 0) && !rebootRequired) return null;

  const security = securityCount !== null && securityCount > 0;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {count !== null && count > 0 ? (
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            security
              ? "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300"
              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          }`}
        >
          {count} update{count === 1 ? "" : "s"}
          {security ? ` (${securityCount} security)` : ""}
        </span>
      ) : null}
      {rebootRequired ? (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          Reboot required
        </span>
      ) : null}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "bad";
  sub?: string;
}) {
  const toneClass =
    tone === "bad"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-slate-900 dark:text-slate-100";
  return (
    <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</div>
      {sub ? <div className="text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}
