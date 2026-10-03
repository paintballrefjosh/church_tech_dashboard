"use client";

import { Server, Apple, MonitorSmartphone, CircleCheck, AlertTriangle, CircleHelp, Power } from "lucide-react";
import { type InfraOs, type InfraStatus, findInfraCapability } from "@church/shared";

export const OS_META: Record<InfraOs, { label: string; Icon: typeof Server }> = {
  linux: { label: "Linux", Icon: Server },
  mac: { label: "macOS", Icon: Apple },
  windows: { label: "Windows", Icon: MonitorSmartphone },
};

/** Short human labels for a target's enabled capabilities (for badges). */
export function capabilityLabels(capabilities: readonly string[]): string[] {
  return capabilities.map((c) => findInfraCapability(c)?.label ?? c);
}

export function StatusPill({ status, enabled }: { status: InfraStatus; enabled?: boolean }) {
  if (enabled === false) {
    return (
      <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
        <Power className="h-4 w-4" aria-hidden /> Paused
      </span>
    );
  }
  if (status === "up")
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
        <CircleCheck className="h-4 w-4" aria-hidden /> Up
      </span>
    );
  if (status === "degraded")
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Degraded
      </span>
    );
  if (status === "down")
    return (
      <span className="inline-flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
        <AlertTriangle className="h-4 w-4" aria-hidden /> Down
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
      <CircleHelp className="h-4 w-4" aria-hidden /> Unknown
    </span>
  );
}

/** Horizontal utilization bar with a value label; colour ramps green→amber→rose. */
export function Gauge({ label, pct }: { label: string; pct: number | null | undefined }) {
  const v = pct === null || pct === undefined ? null : Math.max(0, Math.min(100, pct));
  const colour =
    v === null ? "bg-slate-300 dark:bg-slate-700" : v >= 90 ? "bg-rose-500" : v >= 75 ? "bg-amber-500" : "bg-emerald-500";
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-medium tabular-nums">{v === null ? "—" : `${Math.round(v)}%`}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div className={`h-full rounded-full ${colour}`} style={{ width: `${v ?? 0}%` }} />
      </div>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-base font-medium">{value}</div>
    </div>
  );
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatBps(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${formatBytes(n)}/s`;
}

export function formatUptime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
