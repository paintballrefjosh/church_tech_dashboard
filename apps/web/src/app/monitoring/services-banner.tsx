"use client";

import { useEffect, useState } from "react";
import {
  Database,
  HardDrive,
  Search,
  Activity,
  Server,
  Globe,
  ShieldCheck,
  CircleCheck,
  AlertTriangle,
  CircleHelp,
} from "lucide-react";
import { Lightbox } from "@/components/lightbox";

type Status = "ok" | "degraded" | "down" | "unknown";

interface ServiceReport {
  name: string;
  kind: string;
  status: Status;
  latencyMs?: number;
  message?: string;
  details?: Record<string, string>;
}

interface ServicesResponse {
  services: ServiceReport[];
  ts: string;
}

/**
 * Banner of platform-service health that lives at the top of /monitoring. The
 * api probes its real runtime dependencies (DB, MinIO, Meili, monitor worker)
 * and we synthesise three implicit "we're here, so it must be up" cards for
 * the request-path components (Caddy, Web, API) — if any of those were down
 * this page wouldn't render at all.
 *
 * Auto-refreshes every 30s. Errors fall through silently so a transient probe
 * blip doesn't blank the banner.
 */
export function ServicesBanner() {
  const [report, setReport] = useState<ServicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ServiceReport | null>(null);

  async function refresh() {
    try {
      const r = await fetch("/api/health/services", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) {
        setError(`Couldn't load service health (${r.status})`);
        return;
      }
      setReport((await r.json()) as ServicesResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void refresh();
    // 10s ticks the platform banner roughly in step with the monitor list (5s)
    // without doubling DB / MinIO / Meili probe load — service health changes
    // on minute-or-longer timescales in practice.
    const t = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(t);
  }, []);

  // Implicit services — we got here, so request-path components are up.
  const implicit: ServiceReport[] = [
    { name: "Reverse proxy", kind: "caddy", status: "ok" },
    { name: "Web (Next.js)", kind: "web", status: "ok" },
    { name: "API (NestJS)", kind: "api", status: "ok" },
  ];
  const probed = report?.services ?? [];
  const all = [...implicit, ...probed];

  // Overall: down if any service is down, degraded if any degraded/unknown, ok otherwise.
  const overall: Status = all.some((s) => s.status === "down")
    ? "down"
    : all.some((s) => s.status === "degraded" || s.status === "unknown")
      ? "degraded"
      : "ok";

  return (
    <section className="mb-6 rounded-md border border-slate-300 dark:border-slate-800">
      <header className="flex items-center gap-2 border-b border-slate-300 px-4 py-2.5 dark:border-slate-800">
        <OverallDot status={overall} />
        <h2 className="text-sm font-semibold">Platform status</h2>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {overall === "ok"
            ? "All services nominal"
            : overall === "degraded"
              ? "Degraded — some services need attention"
              : "Down — one or more services unavailable"}
        </span>
        {report?.ts ? (
          <span className="ml-auto text-[10px] uppercase tracking-wide text-slate-400">
            checked {new Date(report.ts).toLocaleTimeString()}
          </span>
        ) : null}
      </header>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-2 p-3 sm:grid-cols-3 md:grid-cols-4">
        {all.map((s) => (
          <li key={s.kind}>
            <button
              type="button"
              onClick={() => setOpen(s)}
              title={s.message ?? "Click for details"}
              className="flex w-full items-center gap-2 rounded-md border border-slate-100 px-2.5 py-2 text-left transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:hover:border-slate-600 dark:hover:bg-slate-800/50"
            >
              <KindIcon kind={s.kind} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">{s.name}</div>
                <div className="truncate text-[10px] text-slate-500 dark:text-slate-400">
                  {statusLabel(s)}
                </div>
              </div>
              <StatusDot status={s.status} />
            </button>
          </li>
        ))}
      </ul>
      {error ? (
        <p className="border-t border-slate-300 px-4 py-2 text-xs text-rose-600 dark:border-slate-800">
          {error}
        </p>
      ) : null}
      {open ? <ServiceDetail service={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function ServiceDetail({
  service,
  onClose,
}: {
  service: ServiceReport;
  onClose: () => void;
}) {
  const entries = Object.entries(service.details ?? {});
  // The "implicit" cards (caddy/web/api) have no details — explain that.
  const implicit = service.kind === "caddy" || service.kind === "web" || service.kind === "api";
  return (
    <Lightbox onClose={onClose}>
      <div className="w-[min(36rem,90vw)] rounded-md border border-slate-300 bg-white p-5 text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
        <header className="mb-3 flex items-center gap-2">
          <KindIcon kind={service.kind} />
          <h3 className="flex-1 truncate text-base font-semibold">{service.name}</h3>
          <StatusDot status={service.status} />
          <span className="text-xs font-medium capitalize text-slate-600 dark:text-slate-300">
            {service.status}
          </span>
        </header>

        {service.message ? (
          <p
            className={`mb-3 rounded-md border px-3 py-2 text-xs ${
              service.status === "down"
                ? "border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-800 dark:bg-rose-950/60 dark:text-rose-200"
                : service.status === "degraded"
                  ? "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200"
                  : "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            }`}
          >
            {service.message}
          </p>
        ) : null}

        {entries.length > 0 ? (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
            {entries.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="font-medium text-slate-500 dark:text-slate-400">{k}</dt>
                <dd className="break-all font-mono text-slate-700 dark:text-slate-200">{v}</dd>
              </div>
            ))}
          </dl>
        ) : implicit ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No live probe — this card reports OK by inference: if this page rendered, the request
            travelled through {service.name} successfully.
          </p>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">No further details available.</p>
        )}

        {service.latencyMs !== undefined ? (
          <p className="mt-3 text-[10px] uppercase tracking-wide text-slate-400">
            probe latency: {service.latencyMs} ms
          </p>
        ) : null}
      </div>
    </Lightbox>
  );
}

function KindIcon({ kind }: { kind: string }) {
  const cls = "h-4 w-4 shrink-0 text-slate-500";
  switch (kind) {
    case "caddy":
      return <Globe className={cls} aria-hidden />;
    case "web":
      return <Server className={cls} aria-hidden />;
    case "api":
      return <ShieldCheck className={cls} aria-hidden />;
    case "cockroachdb":
    case "yugabytedb":
    case "postgresql":
    case "database":
      return <Database className={cls} aria-hidden />;
    case "garage":
    case "minio":
    case "s3":
      return <HardDrive className={cls} aria-hidden />;
    case "meilisearch":
      return <Search className={cls} aria-hidden />;
    case "monitor":
      return <Activity className={cls} aria-hidden />;
    default:
      return <Server className={cls} aria-hidden />;
  }
}

function StatusDot({ status }: { status: Status }) {
  if (status === "ok") return <CircleCheck className="h-4 w-4 text-emerald-500" aria-label="OK" />;
  if (status === "down")
    return <AlertTriangle className="h-4 w-4 text-rose-500" aria-label="Down" />;
  if (status === "degraded")
    return <AlertTriangle className="h-4 w-4 text-amber-500" aria-label="Degraded" />;
  return <CircleHelp className="h-4 w-4 text-slate-400" aria-label="Unknown" />;
}

function OverallDot({ status }: { status: Status }) {
  const cls =
    status === "ok"
      ? "bg-emerald-500"
      : status === "degraded"
        ? "bg-amber-500"
        : status === "down"
          ? "bg-rose-500"
          : "bg-slate-400";
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${cls}`} aria-hidden />;
}

function statusLabel(s: ServiceReport): string {
  const base =
    s.status === "ok"
      ? "ok"
      : s.status === "degraded"
        ? "degraded"
        : s.status === "down"
          ? "down"
          : "unknown";
  if (s.latencyMs !== undefined && s.status === "ok") return `${base} · ${s.latencyMs}ms`;
  if (s.message) return s.message;
  return base;
}
