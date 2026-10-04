"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search, Plus, Pencil, Trash2 } from "lucide-react";
import {
  DNS_EDITABLE_TYPES,
  DNS_STATS_RANGES,
  type DnsEditableType,
  type DnsRecord,
  type DnsRecordData,
  type DnsHealthMonitorsResult,
  type DnsSyncAction,
  type DnsSyncPlan,
  type DnsSyncRun,
  type DnsSyncStatus,
  type DnsStats,
  type DnsStatsRange,
  type DnsSummary,
  type DnsTopEntry,
  type DnsZone,
} from "@church/shared";
import { useCanWrite, inputCls, cardCls, fmtTime, StatusLine, Modal, Field } from "../network-cisco/cisco-ui";

type View = "overview" | "records" | "sync";

const RANGE_LABELS: Record<DnsStatsRange, string> = {
  LastHour: "Last hour",
  LastDay: "Last 24h",
  LastWeek: "Last 7 days",
  LastMonth: "Last 30 days",
};

const fmtNum = (n: number): string => n.toLocaleString();
const pctOf = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—";

async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const r = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    if (r.ok) return { ok: true, data: (await r.json()) as T };
    const body = (await r.json().catch(() => null)) as { message?: unknown } | null;
    return { ok: false, error: typeof body?.message === "string" ? body.message : `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export default function DnsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <DnsPageInner />
    </Suspense>
  );
}

function DnsPageInner() {
  const canWrite = useCanWrite();
  const [summary, setSummary] = useState<DnsSummary | null>(null);
  // `?view=`, `?zone=` and `?q=` drive the page so search results can deep-link
  // here, including while the tab is already open. The page's own
  // history.replaceState updates feed back through useSearchParams with the
  // values the state already holds, so those round-trips are no-ops.
  const params = useSearchParams();
  const paramZone = params.get("zone");
  const paramQ = params.get("q") ?? "";
  const rawView = params.get("view");
  const paramView: View = rawView === "sync" ? "sync" : rawView === "records" || paramZone ? "records" : "overview";
  const [view, setView] = useState<View>(paramView);
  useEffect(() => setView(paramView), [paramView]);

  const loadSummary = useCallback(async () => {
    const r = await getJson<DnsSummary>("/api/dns/summary");
    if (r.ok) setSummary(r.data);
  }, []);

  useEffect(() => {
    void loadSummary();
    const t = setInterval(() => void loadSummary(), 30_000);
    return () => clearInterval(t);
  }, [loadSummary]);

  if (!summary) return <p className="text-sm text-slate-500">Loading…</p>;

  if (!summary.configured) {
    return (
      <div className="rounded-md border border-dashed border-slate-300 p-10 text-center dark:border-slate-700">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          DNS is not configured. Set the Technitium primary URL and API token under{" "}
          {canWrite ? (
            <Link href="/admin/settings/monitoring" className="font-medium text-brand-700 hover:underline dark:text-brand-300">
              Monitoring settings
            </Link>
          ) : (
            <span className="font-medium">Monitoring settings</span>
          )}
          .
        </p>
      </div>
    );
  }

  const switchView = (v: View) => {
    setView(v);
    const url = new URL(window.location.href);
    url.searchParams.set("view", v);
    if (v !== "records") {
      url.searchParams.delete("zone");
      url.searchParams.delete("q");
    }
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-5">
      <ServerHeader summary={summary} onRefresh={() => void loadSummary()} />

      <div className="flex gap-1 text-sm" role="tablist">
        {(["overview", "records", "sync"] as const).map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            onClick={() => switchView(v)}
            className={`rounded-md px-3 py-1.5 font-medium ${
              view === v
                ? "bg-brand-600 text-white"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            }`}
          >
            {v === "overview" ? "Overview" : v === "records" ? "Records" : "IPAM sync"}
          </button>
        ))}
      </div>

      {!summary.reachable ? null : view === "overview" ? (
        <Overview summary={summary} canWrite={canWrite} />
      ) : view === "sync" ? (
        <SyncView canWrite={canWrite} />
      ) : (
        <Records paramZone={paramZone} paramQ={paramQ} canWrite={canWrite} />
      )}
    </div>
  );
}

function ServerHeader({ summary, onRefresh }: { summary: DnsSummary; onRefresh: () => void }) {
  const ok = summary.reachable;
  return (
    <section className={`${cardCls} flex flex-wrap items-center justify-between gap-3`}>
      <div className="flex items-center gap-3">
        <span
          className={`h-2.5 w-2.5 rounded-full ${ok ? (summary.unreachableNodes > 0 ? "bg-amber-500" : "bg-emerald-500") : "bg-rose-500"}`}
          aria-hidden
        />
        <div>
          <div className="text-sm font-medium">
            {ok ? (summary.server ?? "Technitium") : "Primary unreachable"}
            {ok && summary.version ? (
              <span className="ml-2 text-xs font-normal text-slate-500">Technitium {summary.version}</span>
            ) : null}
          </div>
          <div className="text-xs text-slate-500">
            {ok
              ? `${summary.zoneCount} zone${summary.zoneCount === 1 ? "" : "s"} · ${
                  summary.clustered ? "cluster" : "single node, not clustered"
                }`
              : summary.error}
          </div>
        </div>
      </div>
      <button
        onClick={onRefresh}
        title="Refresh"
        className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      >
        <RefreshCw className="h-4 w-4" />
      </button>
    </section>
  );
}

const NODE_STATE_CLS: Record<string, string> = {
  Self: "bg-emerald-500",
  Connected: "bg-emerald-500",
  Unreachable: "bg-rose-500",
};

function Overview({ summary, canWrite }: { summary: DnsSummary; canWrite: boolean }) {
  const [range, setRange] = useState<DnsStatsRange>("LastDay");
  const [stats, setStats] = useState<DnsStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await getJson<DnsStats>(`/api/dns/stats?range=${range}`);
    if (r.ok) {
      setStats(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [range]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const t = stats?.totals;
  const tiles = t
    ? [
        { label: "Queries", value: fmtNum(t.queries), tone: "text-slate-900 dark:text-slate-100" },
        { label: "Blocked", value: pctOf(t.blocked, t.queries), sub: fmtNum(t.blocked), tone: "text-amber-600 dark:text-amber-400" },
        { label: "Cached", value: pctOf(t.cached, t.queries), sub: fmtNum(t.cached), tone: "text-slate-900 dark:text-slate-100" },
        {
          label: "Failures",
          value: fmtNum(t.serverFailure),
          sub: `${fmtNum(t.nxDomain)} NXDOMAIN`,
          tone: t.serverFailure > 0 ? "text-rose-600 dark:text-rose-400" : "text-slate-900 dark:text-slate-100",
        },
        { label: "Clients", value: fmtNum(t.clients), tone: "text-slate-900 dark:text-slate-100" },
      ]
    : [];

  return (
    <div className="space-y-5">
      {summary.nodes ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Cluster nodes</h2>
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Node</th>
                  <th className="px-3 py-2">IP</th>
                  <th className="px-3 py-2">Role</th>
                  <th className="px-3 py-2">State</th>
                  <th className="px-3 py-2">Version</th>
                  <th className="px-3 py-2">Last seen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {summary.nodes.map((n) => (
                  <tr key={n.name}>
                    <td className="px-3 py-2 font-medium">{n.name}</td>
                    <td className="px-3 py-2 font-mono text-xs">{n.ipAddress ?? "—"}</td>
                    <td className="px-3 py-2">{n.type}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium">
                        <span className={`h-2 w-2 rounded-full ${NODE_STATE_CLS[n.state] ?? "bg-amber-500"}`} aria-hidden />
                        {n.state === "Self" ? "This node" : n.state}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs">{n.version ?? "—"}</td>
                    <td className="px-3 py-2 text-xs text-slate-500">{n.state === "Self" ? "—" : fmtTime(n.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : summary.clustered ? (
        <p className="text-xs text-slate-500">
          Node list unavailable: the API token needs View on Administration in Technitium.
        </p>
      ) : null}

      {canWrite ? <HealthMonitorsCard summary={summary} /> : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Queries{stats ? (stats.cluster ? " · whole cluster" : " · this node") : ""}
          </h2>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value as DnsStatsRange)}
            className={`${inputCls} py-1`}
            aria-label="Stats range"
          >
            {DNS_STATS_RANGES.map((r) => (
              <option key={r} value={r}>
                {RANGE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        {error ? <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}
        {stats ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {tiles.map((tile) => (
                <div key={tile.label} className={cardCls}>
                  <div className="text-xs uppercase tracking-wide text-slate-500">{tile.label}</div>
                  <div className={`mt-1 text-2xl font-semibold tabular-nums ${tile.tone}`}>{tile.value}</div>
                  {tile.sub ? <div className="text-xs text-slate-500 tabular-nums">{tile.sub}</div> : null}
                </div>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <TopList title="Top clients" rows={stats.topClients} showDomain />
              <TopList title="Top domains" rows={stats.topDomains} />
              <TopList title="Top blocked" rows={stats.topBlockedDomains} />
            </div>
          </>
        ) : !error ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * One-click `dns` uptime monitors, one per node, each resolving a canary TXT
 * record through that node. A dead node, or a secondary that stopped getting
 * zone transfers, then opens an incident like any other monitor.
 */
function HealthMonitorsCard({ summary }: { summary: DnsSummary }) {
  const defaultIps = (summary.nodes ?? []).map((n) => n.ipAddress).filter((ip): ip is string => Boolean(ip));
  const [ips, setIps] = useState(defaultIps.join(", "));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const create = async () => {
    setBusy(true);
    setMsg(null);
    const nodes = ips
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const r = await fetch("/api/dns/health-monitors", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(nodes.length ? { nodes } : {}),
      });
      const body = (await r.json().catch(() => null)) as DnsHealthMonitorsResult | null;
      if (!r.ok || !body) {
        setMsg({ ok: false, text: errorText(body, r.status) });
        return;
      }
      const made = body.created.length;
      const had = body.existing.length;
      setMsg({
        ok: true,
        text: `${made} monitor${made === 1 ? "" : "s"} created${had ? `, ${had} already existed` : ""}. Each resolves ${body.canary} through its node.`,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={cardCls}>
      <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Health monitors</h2>
      <p className="mt-1 text-xs text-slate-500">
        Adds a DNS uptime monitor per node (shown under{" "}
        <Link href="/monitoring" className="font-medium text-brand-700 hover:underline dark:text-brand-300">
          Services
        </Link>
        ) that resolves a canary record through it, so a dead node or a secondary that stopped receiving zone
        transfers opens an incident.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1">
          <span className="text-xs text-slate-500">Node IPs</span>
          <input
            value={ips}
            onChange={(e) => setIps(e.target.value)}
            placeholder="10.0.0.53, 10.0.1.53"
            className={`${inputCls} mt-1 block w-full font-mono`}
          />
        </label>
        <button
          onClick={() => void create()}
          disabled={busy}
          className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Creating…" : "Create health monitors"}
        </button>
      </div>
      {msg ? (
        <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-700 dark:text-emerald-300" : "text-rose-600 dark:text-rose-400"}`}>{msg.text}</p>
      ) : null}
    </section>
  );
}

function TopList({ title, rows, showDomain }: { title: string; rows: DnsTopEntry[]; showDomain?: boolean }) {
  const max = rows.reduce((m, r) => Math.max(m, r.hits), 0);
  return (
    <div className={cardCls}>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">None in this range.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.name} className="text-xs">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-mono" title={r.name}>
                  {showDomain && r.domain ? r.domain : r.name}
                </span>
                <span className="shrink-0 tabular-nums text-slate-500">{fmtNum(r.hits)}</span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-slate-100 dark:bg-slate-800">
                <div className="h-1 rounded bg-brand-500" style={{ width: `${max > 0 ? (r.hits / max) * 100 : 0}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ZONE_FLAG_CLS = "rounded bg-rose-100 px-1 text-[10px] font-medium text-rose-700 dark:bg-rose-900/40 dark:text-rose-300";

/** Turn an API error body (Nest message string, or a zod `flatten()`) into one line. */
function errorText(body: unknown, status: number): string {
  const b = body as { message?: unknown; formErrors?: unknown; fieldErrors?: unknown } | null;
  if (typeof b?.message === "string") return b.message;
  const parts: string[] = [];
  if (Array.isArray(b?.formErrors)) parts.push(...(b.formErrors as string[]));
  if (b?.fieldErrors && typeof b.fieldErrors === "object") {
    for (const [field, msgs] of Object.entries(b.fieldErrors as Record<string, string[]>)) {
      parts.push(`${field}: ${msgs.join(", ")}`);
    }
  }
  return parts.length > 0 ? parts.join("; ") : `Request failed (HTTP ${status})`;
}

async function sendJson(url: string, method: string, body: unknown): Promise<string | null> {
  try {
    const r = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) return null;
    return errorText(await r.json().catch(() => null), r.status);
  } catch (err) {
    return (err as Error).message;
  }
}

function Records({ paramZone, paramQ, canWrite }: { paramZone: string | null; paramQ: string; canWrite: boolean }) {
  const [zones, setZones] = useState<DnsZone[] | null>(null);
  const [zone, setZone] = useState<string | null>(paramZone);
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [q, setQ] = useState(paramQ);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [editing, setEditing] = useState<{ mode: "create" } | { mode: "edit"; record: DnsRecord } | null>(null);

  // A search-result click while this view is open changes the URL params.
  useEffect(() => {
    if (paramZone) setZone(paramZone);
  }, [paramZone]);
  useEffect(() => {
    setQ(paramQ);
  }, [paramQ]);

  useEffect(() => {
    void (async () => {
      const r = await getJson<DnsZone[]>("/api/dns/zones");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setZones(r.data);
      // Default to the first Primary zone that isn't a reverse zone.
      setZone(
        (cur) =>
          cur ??
          r.data.find((z) => z.type === "Primary" && !z.name.endsWith(".arpa"))?.name ??
          r.data[0]?.name ??
          null,
      );
    })();
  }, []);

  const loadRecords = useCallback(async () => {
    if (!zone) return;
    setRecords(null);
    const r = await getJson<DnsRecord[]>(`/api/dns/zones/${encodeURIComponent(zone)}/records`);
    if (r.ok) {
      setRecords(r.data);
      setError(null);
    } else {
      setError(r.error);
    }
  }, [zone]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  // Keep the URL shareable (and matching what search deep-links to).
  useEffect(() => {
    if (!zone) return;
    const url = new URL(window.location.href);
    url.searchParams.set("view", "records");
    url.searchParams.set("zone", zone);
    if (q) url.searchParams.set("q", q);
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", url);
  }, [zone, q]);

  const filtered = useMemo(() => {
    if (!records) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return records;
    return records.filter(
      (r) =>
        r.name.toLowerCase().includes(needle) ||
        r.value.toLowerCase().includes(needle) ||
        r.type.toLowerCase() === needle ||
        (r.comments ?? "").toLowerCase().includes(needle),
    );
  }, [records, q]);

  // Show names relative to the zone ("@" for the apex) — the zone is in the picker.
  const rel = (name: string): string => {
    if (!zone) return name;
    if (name === zone) return "@";
    return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
  };

  // Only primary zones accept edits; secondaries are read-only copies.
  const zoneInfo = zones?.find((z) => z.name === zone) ?? null;
  const zoneWritable = canWrite && zoneInfo?.type === "Primary";

  const removeRecord = async (r: DnsRecord) => {
    if (!zone || !r.data) return;
    if (!confirm(`Delete ${r.type} record ${rel(r.name)} → ${r.value}?`)) return;
    const err = await sendJson(`/api/dns/zones/${encodeURIComponent(zone)}/records`, "DELETE", {
      name: r.name,
      data: r.data,
    });
    setStatus(err ? { ok: false, text: err } : { ok: true, text: `Deleted ${r.type} ${rel(r.name)}.` });
    if (!err) await loadRecords();
  };

  if (error && !zones) return <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  if (!zones) return <p className="text-sm text-slate-500">Loading…</p>;
  if (zones.length === 0) {
    return <p className="text-sm text-slate-500">No zones on this server yet. Create them in Technitium.</p>;
  }

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
      <nav className="space-y-0.5 text-sm" aria-label="Zones">
        {zones.map((z) => (
          <button
            key={z.name}
            onClick={() => {
              setZone(z.name);
              setStatus(null);
            }}
            aria-current={zone === z.name ? "true" : undefined}
            className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${
              zone === z.name
                ? "bg-brand-50 font-medium text-brand-800 dark:bg-brand-950 dark:text-brand-200"
                : "hover:bg-slate-100 dark:hover:bg-slate-800"
            }`}
          >
            <span className="min-w-0">
              <span className={`block truncate font-mono text-xs ${z.disabled ? "line-through opacity-60" : ""}`} title={z.name}>
                {z.name}
              </span>
              <span className="text-[10px] text-slate-500">{z.type}</span>
            </span>
            <span className="flex shrink-0 gap-1">
              {z.syncFailed ? <span className={ZONE_FLAG_CLS} title="Last zone transfer failed">sync</span> : null}
              {z.notifyFailed ? <span className={ZONE_FLAG_CLS} title="NOTIFY to a secondary failed">notify</span> : null}
              {z.isExpired ? <span className={ZONE_FLAG_CLS} title="Secondary copy expired">expired</span> : null}
            </span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name, value or type"
              className={`${inputCls} w-full pl-8`}
              aria-label="Filter records"
            />
          </div>
          <button
            onClick={() => void loadRecords()}
            title="Reload records"
            className="rounded p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {zoneWritable ? (
            <button
              onClick={() => {
                setStatus(null);
                setEditing({ mode: "create" });
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" /> Add record
            </button>
          ) : null}
        </div>

        {canWrite && zoneInfo && zoneInfo.type !== "Primary" ? (
          <p className="text-xs text-slate-500">
            This is a {zoneInfo.type.toLowerCase()} zone; edit its records on the zone&apos;s primary.
          </p>
        ) : null}
        <StatusLine status={status} />
        {error ? <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p> : null}

        {!filtered ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2 text-right">TTL</th>
                  {zoneWritable ? <th className="px-3 py-2 text-right">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={zoneWritable ? 5 : 4} className="px-3 py-6 text-center text-sm text-slate-500">
                      {records && records.length > 0 ? "No records match the filter." : "This zone has no records."}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => (
                    <tr
                      key={`${r.name}|${r.type}|${r.value}|${i}`}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-900 ${r.disabled ? "opacity-50" : ""}`}
                    >
                      <td className="px-3 py-1.5 font-mono text-xs" title={r.name}>
                        {rel(r.name)}
                        {r.managed ? (
                          <span className="ml-1.5 rounded bg-indigo-100 px-1 font-sans text-[10px] font-medium text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300">
                            managed
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-1.5 text-xs font-medium">{r.type}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all">
                        {r.value}
                        {r.comments ? <div className="font-sans text-[11px] text-slate-500">{r.comments}</div> : null}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-slate-500">{r.ttl}</td>
                      {zoneWritable ? (
                        <td className="px-3 py-1.5">
                          {r.data && !r.managed ? (
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => {
                                  setStatus(null);
                                  setEditing({ mode: "edit", record: r });
                                }}
                                title="Edit record"
                                className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => void removeRecord(r)}
                                title="Delete record"
                                className="rounded p-1.5 text-slate-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-900/40 dark:hover:text-rose-300"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
        {filtered && records ? (
          <p className="text-[11px] text-slate-400">
            {filtered.length} of {records.length} records. DNSSEC signing records are hidden.
          </p>
        ) : null}
      </div>

      {editing && zone ? (
        <RecordForm
          zone={zone}
          record={editing.mode === "edit" ? editing.record : null}
          relName={rel}
          onClose={() => setEditing(null)}
          onSaved={async (text) => {
            setEditing(null);
            setStatus({ ok: true, text });
            await loadRecords();
          }}
        />
      ) : null}
    </div>
  );
}

/** Form values as strings; converted to typed `DnsRecordData` on submit. */
interface FormState {
  type: DnsEditableType;
  name: string;
  ttl: string;
  comments: string;
  ipAddress: string;
  target: string;
  preference: string;
  text: string;
  splitText: boolean;
  priority: string;
  weight: string;
  port: string;
}

function formFromRecord(r: DnsRecord | null, relName: (n: string) => string): FormState {
  const f: FormState = {
    type: "A",
    name: "",
    ttl: "3600",
    comments: "",
    ipAddress: "",
    target: "",
    preference: "10",
    text: "",
    splitText: false,
    priority: "0",
    weight: "0",
    port: "",
  };
  if (!r || !r.data) return f;
  const d = r.data;
  f.type = d.type;
  f.name = relName(r.name);
  f.ttl = String(r.ttl);
  f.comments = r.comments ?? "";
  switch (d.type) {
    case "A":
    case "AAAA":
      f.ipAddress = d.ipAddress;
      break;
    case "CNAME":
      f.target = d.cname;
      break;
    case "PTR":
      f.target = d.ptrName;
      break;
    case "MX":
      f.preference = String(d.preference);
      f.target = d.exchange;
      break;
    case "TXT":
      f.text = d.text;
      f.splitText = d.splitText;
      break;
    case "SRV":
      f.priority = String(d.priority);
      f.weight = String(d.weight);
      f.port = String(d.port);
      f.target = d.target;
      break;
  }
  return f;
}

function dataFromForm(f: FormState): DnsRecordData {
  const n = (v: string): number => (v.trim() === "" ? Number.NaN : Number(v));
  switch (f.type) {
    case "A":
    case "AAAA":
      return { type: f.type, ipAddress: f.ipAddress.trim() };
    case "CNAME":
      return { type: "CNAME", cname: f.target.trim() };
    case "PTR":
      return { type: "PTR", ptrName: f.target.trim() };
    case "MX":
      return { type: "MX", preference: n(f.preference), exchange: f.target.trim() };
    case "TXT":
      return { type: "TXT", text: f.text, splitText: f.splitText };
    case "SRV":
      return { type: "SRV", priority: n(f.priority), weight: n(f.weight), port: n(f.port), target: f.target.trim() };
  }
}

const TARGET_LABEL: Partial<Record<DnsEditableType, string>> = {
  CNAME: "Points to (domain)",
  PTR: "Host name",
  MX: "Mail server",
  SRV: "Target host",
};

function RecordForm({
  zone,
  record,
  relName,
  onClose,
  onSaved,
}: {
  zone: string;
  record: DnsRecord | null;
  relName: (n: string) => string;
  onClose: () => void;
  onSaved: (text: string) => Promise<void>;
}) {
  const [f, setF] = useState<FormState>(() => formFromRecord(record, relName));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const editing = record !== null && record.data !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const ttl = f.ttl.trim() === "" ? undefined : Number(f.ttl);
    const data = dataFromForm(f);
    const url = `/api/dns/zones/${encodeURIComponent(zone)}/records`;
    const error = editing
      ? await sendJson(url, "PATCH", {
          current: { name: record.name, data: record.data },
          name: f.name.trim() || "@",
          ttl: ttl ?? record.ttl,
          comments: f.comments,
          data,
        })
      : await sendJson(url, "POST", { name: f.name.trim() || "@", ttl, comments: f.comments, data });
    setBusy(false);
    if (error) {
      setErr(error);
      return;
    }
    await onSaved(`${editing ? "Updated" : "Added"} ${data.type} ${f.name.trim() || "@"}.`);
  };

  const t = f.type;
  return (
    <Modal title={editing ? `Edit ${t} record` : `Add record to ${zone}`} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <Field label="Type">
            <select
              value={t}
              disabled={editing}
              onChange={(e) => set("type", e.target.value as DnsEditableType)}
              className={`${inputCls} w-full`}
            >
              {DNS_EDITABLE_TYPES.map((ty) => (
                <option key={ty} value={ty}>
                  {ty}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Name (relative to ${zone}, @ for the zone itself)`}>
            <input
              value={f.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={t === "SRV" ? "_sip._tcp" : "printer"}
              className={`${inputCls} w-full font-mono`}
            />
          </Field>
        </div>

        {t === "A" || t === "AAAA" ? (
          <Field label={t === "A" ? "IPv4 address" : "IPv6 address"}>
            <input
              value={f.ipAddress}
              onChange={(e) => set("ipAddress", e.target.value)}
              placeholder={t === "A" ? "10.0.10.25" : "fd00::25"}
              className={`${inputCls} w-full font-mono`}
              required
            />
          </Field>
        ) : null}

        {t === "MX" || t === "SRV" ? (
          <div className="grid grid-cols-3 gap-3">
            {t === "MX" ? (
              <Field label="Preference">
                <input type="number" value={f.preference} onChange={(e) => set("preference", e.target.value)} className={`${inputCls} w-full`} required />
              </Field>
            ) : (
              <>
                <Field label="Priority">
                  <input type="number" value={f.priority} onChange={(e) => set("priority", e.target.value)} className={`${inputCls} w-full`} required />
                </Field>
                <Field label="Weight">
                  <input type="number" value={f.weight} onChange={(e) => set("weight", e.target.value)} className={`${inputCls} w-full`} required />
                </Field>
                <Field label="Port">
                  <input type="number" value={f.port} onChange={(e) => set("port", e.target.value)} className={`${inputCls} w-full`} required />
                </Field>
              </>
            )}
          </div>
        ) : null}

        {TARGET_LABEL[t] ? (
          <Field label={TARGET_LABEL[t] ?? ""}>
            <input
              value={f.target}
              onChange={(e) => set("target", e.target.value)}
              placeholder={t === "PTR" ? `printer.${zone}` : "host.example.org"}
              className={`${inputCls} w-full font-mono`}
              required
            />
          </Field>
        ) : null}

        {t === "TXT" ? (
          <>
            <Field label="Text">
              <textarea
                value={f.text}
                onChange={(e) => set("text", e.target.value)}
                rows={3}
                className={`${inputCls} w-full font-mono`}
                required
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={f.splitText} onChange={(e) => set("splitText", e.target.checked)} />
              Split lines into separate character-strings
            </label>
          </>
        ) : null}

        <div className="grid grid-cols-[7rem_1fr] gap-3">
          <Field label="TTL (seconds)">
            <input
              type="number"
              min={0}
              value={f.ttl}
              onChange={(e) => set("ttl", e.target.value)}
              className={`${inputCls} w-full`}
            />
          </Field>
          <Field label="Comment (optional)">
            <input value={f.comments} onChange={(e) => set("comments", e.target.value)} className={`${inputCls} w-full`} />
          </Field>
        </div>

        {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {busy ? "Saving…" : editing ? "Save changes" : "Add record"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- IPAM -> DNS sync ----

interface ManagedRow {
  id: string;
  ipamHostId: string | null;
  zone: string;
  name: string;
  type: string;
  value: string;
  ttl: number;
  state: string;
  lastError: string | null;
  lastSyncedAt: string | null;
}

const OP_CLS: Record<DnsSyncAction["op"], string> = {
  add: "text-emerald-700 dark:text-emerald-300",
  update: "text-amber-700 dark:text-amber-300",
  remove: "text-rose-700 dark:text-rose-300",
};

const TRIGGER_LABEL: Record<DnsSyncRun["trigger"], string> = {
  timer: "Timer",
  manual: "Manual",
  "ipam-scan": "IPAM scan",
  "ipam-edit": "IPAM edit",
};

const thCls = "px-3 py-2";
const tableWrap = "overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800";
const theadCls = "bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400";
const sectionTitle = "mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500";

function SyncView({ canWrite }: { canWrite: boolean }) {
  const [status, setStatus] = useState<DnsSyncStatus | null>(null);
  const [plan, setPlan] = useState<DnsSyncPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [runs, setRuns] = useState<DnsSyncRun[]>([]);
  const [managed, setManaged] = useState<ManagedRow[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Set when a run stopped at the safety limit, so the operator can confirm.
  const [blocked, setBlocked] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [st, pl, rn, mg] = await Promise.all([
      getJson<DnsSyncStatus>("/api/dns/sync/status"),
      getJson<DnsSyncPlan>("/api/dns/sync/plan"),
      getJson<DnsSyncRun[]>("/api/dns/sync/runs"),
      getJson<ManagedRow[]>("/api/dns/sync/managed"),
    ]);
    if (st.ok) setStatus(st.data);
    if (pl.ok) {
      setPlan(pl.data);
      setPlanError(null);
    } else {
      setPlan(null);
      setPlanError(pl.error);
    }
    if (rn.ok) setRuns(rn.data);
    if (mg.ok) setManaged(mg.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runNow = async (force: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/dns/sync", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const body = (await r.json().catch(() => null)) as (DnsSyncRun & { message?: unknown }) | null;
      if (!r.ok) {
        setMsg({ ok: false, text: errorText(body, r.status) });
      } else if (body?.error) {
        // Stopped at the safety limit: nothing applied.
        setBlocked(body.error);
      } else if (body) {
        setBlocked(null);
        setMsg({
          ok: body.failed === 0,
          text: `Sync done: ${body.added} added, ${body.updated} updated, ${body.removed} removed${
            body.conflicts ? `, ${body.conflicts} conflicts` : ""
          }${body.failed ? `, ${body.failed} failed` : ""}.`,
        });
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const createZone = async (zone: string) => {
    const err = await sendJson("/api/dns/reverse-zones", "POST", { zone });
    setMsg(err ? { ok: false, text: err } : { ok: true, text: `Created reverse zone ${zone}.` });
    await load();
  };

  const release = async (m: ManagedRow) => {
    if (!confirm(`Release ${m.type} ${m.name}? It becomes a hand-made record, and its host will show a conflict until you rename or remove it.`)) return;
    const err = await sendJson(`/api/dns/managed/${m.id}/release`, "POST", {});
    setMsg(err ? { ok: false, text: err } : { ok: true, text: `Released ${m.name}.` });
    await load();
  };

  const last = status?.lastRun ?? null;
  const counts = plan
    ? {
        add: plan.actions.filter((a) => a.op === "add").length,
        update: plan.actions.filter((a) => a.op === "update").length,
        remove: plan.actions.filter((a) => a.op === "remove").length,
      }
    : null;

  return (
    <div className="space-y-5">
      <section className={`${cardCls} flex flex-wrap items-center justify-between gap-3`}>
        <div className="text-sm">
          <div className="font-medium">
            {status?.enabled ? "Sync is on" : "Sync is off"}
            {status?.zone ? <span className="ml-2 font-mono text-xs font-normal text-slate-500">{status.zone}</span> : null}
          </div>
          <div className="text-xs text-slate-500">
            {last
              ? `Last run ${fmtTime(last.startedAt)} (${TRIGGER_LABEL[last.trigger]})${
                  last.error ? `: ${last.error}` : `: ${last.added} added, ${last.updated} updated, ${last.removed} removed`
                }`
              : "No runs yet."}
            {!status?.enabled ? " Turn it on in Monitoring settings once the plan below looks right." : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            title="Refresh plan"
            className="rounded p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {canWrite && status?.enabled ? (
            <button
              onClick={() => void runNow(false)}
              disabled={busy}
              className="rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {busy ? "Syncing…" : "Sync now"}
            </button>
          ) : null}
        </div>
      </section>

      <StatusLine status={msg} />

      {blocked ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p>{blocked}</p>
          {canWrite ? (
            <button
              onClick={() => {
                if (confirm("Apply the removals anyway?")) void runNow(true);
              }}
              disabled={busy}
              className="mt-2 rounded-md border border-amber-400 px-3 py-1 text-xs font-medium hover:bg-amber-100 dark:border-amber-600 dark:hover:bg-amber-900"
            >
              Apply anyway
            </button>
          ) : null}
        </div>
      ) : null}

      {planError ? <p className="text-sm text-rose-600 dark:text-rose-400">{planError}</p> : null}

      {plan ? (
        <>
          <section>
            <h2 className={sectionTitle}>Plan</h2>
            <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
              {counts && counts.add + counts.update + counts.remove === 0
                ? `Nothing to change. ${plan.unchanged} synced record${plan.unchanged === 1 ? " is" : "s are"} up to date.`
                : `${counts?.add} to add, ${counts?.update} to update, ${counts?.remove} to remove; ${plan.unchanged} already correct.`}
              {plan.ptr ? "" : " PTR records are off."}
            </p>
            {plan.blocked && !blocked ? (
              <p className="mb-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
                {plan.blocked}
              </p>
            ) : null}
            {plan.actions.length > 0 ? (
              <div className={tableWrap}>
                <table className="w-full text-left text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>Change</th>
                      <th className={thCls}>Type</th>
                      <th className={thCls}>Name</th>
                      <th className={thCls}>Value</th>
                      <th className={thCls}>Why</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {plan.actions.map((a, i) => (
                      <tr key={`${a.op}|${a.zone}|${a.name}|${a.type}|${i}`}>
                        <td className={`px-3 py-1.5 text-xs font-medium capitalize ${OP_CLS[a.op]}`}>{a.op}</td>
                        <td className="px-3 py-1.5 text-xs">{a.type}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">{a.name}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          {a.fromValue && a.fromValue !== a.value ? (
                            <>
                              <span className="text-slate-400 line-through">{a.fromValue}</span> {a.value}
                            </>
                          ) : (
                            a.value
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500">{a.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>

          {plan.conflicts.length > 0 ? (
            <section>
              <h2 className={sectionTitle}>Conflicts</h2>
              <p className="mb-2 text-xs text-slate-500">
                A hand-made record already uses these names, so the sync leaves them alone. Delete or rename the
                hand-made record, or give the host a different DNS name on its IPAM subnet page.
              </p>
              <div className={tableWrap}>
                <table className="w-full text-left text-sm">
                  <thead className={theadCls}>
                    <tr>
                      <th className={thCls}>Name</th>
                      <th className={thCls}>Wanted</th>
                      <th className={thCls}>Already there</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {plan.conflicts.map((c) => (
                      <tr key={`${c.zone}|${c.name}|${c.type}`}>
                        <td className="px-3 py-1.5 font-mono text-xs">{c.name}</td>
                        <td className="px-3 py-1.5 font-mono text-xs">
                          {c.type} {c.value}
                        </td>
                        <td className="px-3 py-1.5 font-mono text-xs text-rose-700 dark:text-rose-300">{c.existing}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {plan.missingReverseZones.length > 0 ? (
            <section>
              <h2 className={sectionTitle}>Missing reverse zones</h2>
              <p className="mb-2 text-xs text-slate-500">
                PTR records for these ranges are skipped until a reverse zone exists. The sync never creates zones by
                itself.
              </p>
              <ul className="space-y-1">
                {plan.missingReverseZones.map((z) => (
                  <li key={z} className="flex items-center gap-3 text-sm">
                    <span className="font-mono text-xs">{z}</span>
                    {canWrite ? (
                      <button
                        onClick={() => void createZone(z)}
                        className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        Create
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      <section>
        <h2 className={sectionTitle}>Synced records ({managed.length})</h2>
        {managed.length === 0 ? (
          <p className="text-xs text-slate-500">None yet.</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full text-left text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Name</th>
                  <th className={thCls}>Type</th>
                  <th className={thCls}>Value</th>
                  <th className={thCls}>State</th>
                  {canWrite ? <th className={`${thCls} text-right`}>Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {managed.map((m) => (
                  <tr key={m.id}>
                    <td className="px-3 py-1.5 font-mono text-xs">{m.name}</td>
                    <td className="px-3 py-1.5 text-xs">{m.type}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{m.value}</td>
                    <td className="px-3 py-1.5 text-xs" title={m.lastError ?? undefined}>
                      {m.state === "ok" ? (
                        <span className="text-emerald-700 dark:text-emerald-300">ok</span>
                      ) : (
                        <span className="text-rose-700 dark:text-rose-300">{m.lastError ?? m.state}</span>
                      )}
                    </td>
                    {canWrite ? (
                      <td className="px-3 py-1.5 text-right">
                        <button
                          onClick={() => void release(m)}
                          className="rounded-md border border-slate-300 px-2 py-0.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                        >
                          Release
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className={sectionTitle}>Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-xs text-slate-500">No runs yet.</p>
        ) : (
          <div className={tableWrap}>
            <table className="w-full text-left text-sm">
              <thead className={theadCls}>
                <tr>
                  <th className={thCls}>Started</th>
                  <th className={thCls}>Trigger</th>
                  <th className={`${thCls} text-right`}>Added</th>
                  <th className={`${thCls} text-right`}>Updated</th>
                  <th className={`${thCls} text-right`}>Removed</th>
                  <th className={`${thCls} text-right`}>Conflicts</th>
                  <th className={thCls}>Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-1.5 text-xs text-slate-500">{fmtTime(r.startedAt)}</td>
                    <td className="px-3 py-1.5 text-xs">{TRIGGER_LABEL[r.trigger]}</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums">{r.added}</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums">{r.updated}</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums">{r.removed}</td>
                    <td className="px-3 py-1.5 text-right text-xs tabular-nums">{r.conflicts}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {r.error ? (
                        <span className="text-rose-700 dark:text-rose-300">{r.error}</span>
                      ) : r.failed > 0 ? (
                        <span className="text-rose-700 dark:text-rose-300">{r.failed} failed</span>
                      ) : !r.finishedAt ? (
                        <span className="text-slate-500">running…</span>
                      ) : (
                        <span className="text-emerald-700 dark:text-emerald-300">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
