"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpToLine, ArrowDownToLine } from "lucide-react";
import type { CiscoDriftRow } from "@church/shared";
import { useCanWrite, fmtTime, StatusLine } from "../cisco-ui";
import { DataTable, type Column } from "@/components/data-table";

export default function CiscoDriftPage() {
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<CiscoDriftRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "detected", dir: "desc" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);

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
      const r = await fetch(`/api/cisco/drift?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const b = (await r.json()) as { rows: CiscoDriftRow[]; total: number };
        setRows(b.rows ?? []);
        setTotal(b.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q, sort]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  async function act(row: CiscoDriftRow, kind: "push" | "accept") {
    setBusy(true);
    setStatus(null);
    try {
      const r = await fetch(`/api/cisco/switches/${row.switchId}/drift/${row.id}/${kind}`, {
        method: "POST",
        credentials: "same-origin",
      });
      setStatus(
        r.ok
          ? { ok: true, text: kind === "push" ? "Pushed desired config to switch." : "Adopted switch value into baseline." }
          : { ok: false, text: `Failed (${r.status})` },
      );
      await fetchPage();
    } finally {
      setBusy(false);
    }
  }

  const columns: Column<CiscoDriftRow>[] = [
    { key: "switch", label: "Switch", render: (r) => <span className="font-medium">{r.switchHostname}</span>, sortValue: (r) => r.switchHostname },
    {
      key: "scope",
      label: "Scope",
      render: (r) =>
        r.portId === "__device__" ? (
          <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-purple-700 dark:bg-purple-900/40 dark:text-purple-300">
            device
          </span>
        ) : (
          <span className="font-mono text-xs">{r.portId}</span>
        ),
      sortValue: (r) => r.portId,
    },
    { key: "field", label: "Field", render: (r) => <span className="text-xs">{r.field}</span>, sortValue: (r) => r.field },
    {
      key: "expected",
      label: "Expected",
      render: (r) => <code className="rounded bg-emerald-50 px-1 text-xs text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300">{r.expected ?? "—"}</code>,
      sortValue: (r) => r.expected ?? "",
    },
    {
      key: "observed",
      label: "Observed",
      render: (r) => <code className="rounded bg-rose-50 px-1 text-xs text-rose-800 dark:bg-rose-950/50 dark:text-rose-300">{r.observed ?? "—"}</code>,
      sortValue: (r) => r.observed ?? "",
    },
    { key: "detected", label: "Detected", render: (r) => <span className="text-xs text-slate-500">{fmtTime(r.detectedAt)}</span>, sortValue: (r) => new Date(r.detectedAt).getTime() },
    ...(canWrite
      ? [
          {
            key: "actions",
            label: "Reconcile",
            align: "right" as const,
            render: (r: CiscoDriftRow) => (
              <div className="flex items-center justify-end gap-2">
                <button type="button" disabled={busy} onClick={() => void act(r, "push")} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-60 dark:border-slate-700 dark:text-brand-300 dark:hover:bg-brand-900/30">
                  <ArrowUpToLine className="h-3 w-3" aria-hidden /> Push
                </button>
                <button type="button" disabled={busy} onClick={() => void act(r, "accept")} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                  <ArrowDownToLine className="h-3 w-3" aria-hidden /> Accept
                </button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Drift log</h2>
        <span className="text-xs text-slate-400">Open drift across the fleet.</span>
      </div>
      <StatusLine status={status} />
      <DataTable
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        initialSort={sort}
        initialPageSize={pageSize}
        filterPlaceholder="Search by switch, port, field…"
        emptyText="No active drift — running configs match their baselines."
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
