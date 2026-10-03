"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CiscoLookupRow } from "@church/shared";
import { fmtTime } from "../cisco-ui";
import { DataTable, type Column } from "@/components/data-table";

type Row = CiscoLookupRow & { _key: string };

export default function CiscoMacPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "mac", dir: "asc" });
  const [excludeUplinks, setExcludeUplinks] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
        sort: sort.key,
        dir: sort.dir,
      });
      if (q) params.set("q", q);
      if (excludeUplinks) params.set("exclude_uplinks", "1");
      const r = await fetch(`/api/cisco/mac?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const b = (await r.json()) as { rows: CiscoLookupRow[]; total: number };
        setRows((b.rows ?? []).map((row, i) => ({ ...row, _key: `${page}-${i}` })));
        setTotal(b.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q, sort, excludeUplinks]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  const columns: Column<Row>[] = [
    { key: "mac", label: "MAC", render: (r) => <span className="font-mono text-xs">{r.macAddress ?? "—"}</span>, sortValue: (r) => r.macAddress ?? "" },
    { key: "ip", label: "IP", render: (r) => <span className="font-mono text-xs">{r.ipAddress ?? "—"}</span>, sortValue: (r) => r.ipAddress ?? "" },
    { key: "host", label: "Hostname", render: (r) => <span className="text-xs">{r.rdnsName ?? "—"}</span>, sortValue: (r) => r.rdnsName ?? "" },
    { key: "vrf", label: "VRF", render: (r) => <span className="text-xs">{r.vrf && r.vrf !== "default" ? r.vrf : "—"}</span> },
    { key: "switch", label: "Switch", render: (r) => <span className="text-xs">{r.switchHostname}</span>, sortValue: (r) => r.switchHostname },
    {
      key: "port",
      label: "Port",
      render: (r) => (
        <span className="font-mono text-xs">
          {r.portId ?? "—"}
          {r.uplinkNeighbor ? <span className="ml-1 rounded bg-purple-100 px-1 text-[10px] text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">uplink</span> : null}
        </span>
      ),
      sortValue: (r) => r.portId ?? "",
    },
    { key: "desc", label: "Description", render: (r) => <span className="text-xs text-slate-500">{r.portDescription ?? "—"}</span> },
    { key: "vlan", label: "VLAN", render: (r) => <span className="text-xs">{r.vlan ?? "—"}</span>, sortValue: (r) => r.vlan ?? 0 },
    { key: "type", label: "Type", render: (r) => <span className="text-xs">{r.macType ?? "—"}</span>, sortValue: (r) => r.macType ?? "" },
    { key: "seen", label: "Last seen", render: (r) => <span className="text-xs text-slate-500">{fmtTime(r.polledAt)}</span> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">MAC / ARP table</h2>
        <span className="text-xs text-slate-400">All learned MAC + IP entries across the fleet.</span>
        <label className="ml-auto inline-flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={excludeUplinks}
            onChange={(e) => {
              setExcludeUplinks(e.target.checked);
              setPage(0);
            }}
            className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700"
          />
          Exclude uplinks
        </label>
        <button
          type="button"
          onClick={() => void fetchPage()}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden /> Refresh
        </button>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(r) => r._key}
        initialSort={sort}
        initialPageSize={pageSize}
        filterPlaceholder="Search by MAC, IP, hostname, switch, port…"
        emptyText="No MAC/IP entries. Poll a switch to collect its L2 tables."
        server={{
          total,
          page,
          pageSize,
          loading,
          onPageChange: setPage,
          onPageSizeChange: (s) => {
            setPageSize(s);
            setPage(0);
          },
          onSearch: (v) => {
            setQ(v);
            setPage(0);
          },
          onSort: (key, dir) => {
            setSort({ key, dir });
            setPage(0);
          },
        }}
      />
    </div>
  );
}
