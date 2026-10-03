"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import {
  DNS_STATS_RANGES,
  type DnsRecord,
  type DnsStats,
  type DnsStatsRange,
  type DnsSummary,
  type DnsTopEntry,
  type DnsZone,
} from "@church/shared";
import { useCanWrite, inputCls, cardCls, fmtTime } from "../network-cisco/cisco-ui";

type View = "overview" | "records";

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

/** Read `?view=`, `?zone=` and `?q=` once on load so search results can deep-link. */
function initialParams(): { view: View; zone: string | null; q: string } {
  if (typeof window === "undefined") return { view: "overview", zone: null, q: "" };
  const p = new URLSearchParams(window.location.search);
  const zone = p.get("zone");
  return {
    view: p.get("view") === "records" || zone ? "records" : "overview",
    zone,
    q: p.get("q") ?? "",
  };
}

export default function DnsPage() {
  const canWrite = useCanWrite();
  const [summary, setSummary] = useState<DnsSummary | null>(null);
  const [view, setView] = useState<View>("overview");
  const [initialZone, setInitialZone] = useState<string | null>(null);
  const [initialQ, setInitialQ] = useState("");

  useEffect(() => {
    const p = initialParams();
    setView(p.view);
    setInitialZone(p.zone);
    setInitialQ(p.q);
  }, []);

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
    if (v === "overview") {
      url.searchParams.delete("zone");
      url.searchParams.delete("q");
    }
    window.history.replaceState(null, "", url);
  };

  return (
    <div className="space-y-5">
      <ServerHeader summary={summary} onRefresh={() => void loadSummary()} />

      <div className="flex gap-1 text-sm" role="tablist">
        {(["overview", "records"] as const).map((v) => (
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
            {v === "overview" ? "Overview" : "Records"}
          </button>
        ))}
      </div>

      {!summary.reachable ? null : view === "overview" ? (
        <Overview summary={summary} />
      ) : (
        <Records initialZone={initialZone} initialQ={initialQ} />
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

function Overview({ summary }: { summary: DnsSummary }) {
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

function Records({ initialZone, initialQ }: { initialZone: string | null; initialQ: string }) {
  const [zones, setZones] = useState<DnsZone[] | null>(null);
  const [zone, setZone] = useState<string | null>(initialZone);
  const [records, setRecords] = useState<DnsRecord[] | null>(null);
  const [q, setQ] = useState(initialQ);
  const [error, setError] = useState<string | null>(null);

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
            onClick={() => setZone(z.name)}
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
        </div>

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
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-slate-500">
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
                      </td>
                      <td className="px-3 py-1.5 text-xs font-medium">{r.type}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all">
                        {r.value}
                        {r.comments ? <div className="font-sans text-[11px] text-slate-500">{r.comments}</div> : null}
                      </td>
                      <td className="px-3 py-1.5 text-right text-xs tabular-nums text-slate-500">{r.ttl}</td>
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
    </div>
  );
}
