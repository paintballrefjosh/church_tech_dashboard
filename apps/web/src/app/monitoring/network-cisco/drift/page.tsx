"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpToLine, ArrowDownToLine, Loader2 } from "lucide-react";
import type { CiscoDriftRow } from "@church/shared";
import { useCanWrite, fmtTime, PendingLine, ToastStack, useToasts } from "../cisco-ui";
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
  // Rows being reconciled, by drift id. Several can run at once: each row's own buttons wait, the rest stay usable.
  // (The server takes turns when two go to the same switch, and runs different switches side by side.)
  const [pending, setPending] = useState<Record<string, { kind: "push" | "accept"; text: string }>>({});
  // What the finished ones said, as toasts in the lower right (each goes after 5 seconds, or when clicked).
  const { toasts, show: showToast, dismiss: dismissToast } = useToasts();
  const fetchSeq = useRef(0);

  const fetchPage = useCallback(async () => {
    // Several actions finish close together and each refreshes the list: only the newest answer is used.
    const seq = ++fetchSeq.current;
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
      if (r.ok && seq === fetchSeq.current) {
        const b = (await r.json()) as { rows: CiscoDriftRow[]; total: number };
        setRows(b.rows ?? []);
        setTotal(b.total ?? 0);
      }
    } finally {
      if (seq === fetchSeq.current) setLoading(false);
    }
  }, [page, pageSize, q, sort]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  async function act(row: CiscoDriftRow, kind: "push" | "accept") {
    if (pending[row.id]) return;
    const what = row.portId === "__device__" ? row.field : `${row.field} on ${row.portId}`;
    setPending((p) => ({
      ...p,
      [row.id]: {
        kind,
        text:
          kind === "push"
            ? `Pushing ${what} to ${row.switchHostname} and saving the config. This can take several seconds.`
            : `Adopting ${what} from ${row.switchHostname}.`,
      },
    }));
    let result: { ok: boolean; text: string };
    try {
      const r = await fetch(`/api/cisco/switches/${row.switchId}/drift/${row.id}/${kind}`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (r.ok) {
        result = {
          ok: true,
          text: kind === "push" ? `Pushed ${what} to ${row.switchHostname}.` : `Adopted ${what} from ${row.switchHostname} into the baseline.`,
        };
      } else {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        result = { ok: false, text: `${kind === "push" ? "Push" : "Accept"} of ${what} on ${row.switchHostname} failed: ${body.message ?? r.status}` };
      }
    } catch {
      result = { ok: false, text: `${kind === "push" ? "Push" : "Accept"} of ${what} on ${row.switchHostname} failed: no answer` };
    }
    showToast(result.ok, result.text);
    setPending((p) => {
      const next = { ...p };
      delete next[row.id];
      return next;
    });
    await fetchPage();
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
                <button type="button" disabled={!!pending[r.id]} onClick={() => void act(r, "push")} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-brand-700 hover:bg-brand-50 disabled:opacity-60 dark:border-slate-700 dark:text-brand-300 dark:hover:bg-brand-900/30">
                  {pending[r.id]?.kind === "push" ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <ArrowUpToLine className="h-3 w-3" aria-hidden />
                  )}{" "}
                  {pending[r.id]?.kind === "push" ? "Pushing…" : "Push"}
                </button>
                <button type="button" disabled={!!pending[r.id]} onClick={() => void act(r, "accept")} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
                  {pending[r.id]?.kind === "accept" ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  ) : (
                    <ArrowDownToLine className="h-3 w-3" aria-hidden />
                  )}{" "}
                  {pending[r.id]?.kind === "accept" ? "Adopting…" : "Accept"}
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
      {Object.entries(pending).map(([id, p]) => (
        <PendingLine key={id} text={p.text} />
      ))}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
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
