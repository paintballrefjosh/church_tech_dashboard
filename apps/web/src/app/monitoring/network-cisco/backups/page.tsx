"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { CiscoBackupRow, CiscoBackupDiffLine } from "@church/shared";
import { useCanWrite, fmtBytes, fmtTime } from "../cisco-ui";
import { DataTable, type Column } from "@/components/data-table";

type Sel = { id: string; switchId: string };

export default function CiscoBackupsPage() {
  const canWrite = useCanWrite();
  const [rows, setRows] = useState<CiscoBackupRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "at", dir: "desc" });
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<Sel[]>([]);
  const [viewing, setViewing] = useState<{ id: string; text: string } | null>(null);
  const [diff, setDiff] = useState<{ diff: CiscoBackupDiffLine[]; added: number; removed: number } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
        sort: sort.key,
        dir: sort.dir,
      });
      if (q) params.set("q", q);
      const r = await fetch(`/api/cisco/backups?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const b = (await r.json()) as { rows: CiscoBackupRow[]; total: number };
        setRows(b.rows ?? []);
        setTotal(b.total ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, q, sort]);
  useEffect(() => {
    void load();
  }, [load]);

  function toggleSel(row: CiscoBackupRow) {
    setSel((prev) => {
      if (prev.some((s) => s.id === row.id)) return prev.filter((s) => s.id !== row.id);
      const next = [...prev, { id: row.id, switchId: row.switchId }];
      return next.slice(-2); // keep at most 2
    });
  }

  async function view(row: CiscoBackupRow) {
    setDiff(null);
    if (viewing?.id === row.id) {
      setViewing(null);
      return;
    }
    const r = await fetch(`/api/cisco/switches/${row.switchId}/backups/${row.id}`, { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setViewing({ id: row.id, text: ((await r.json()) as { configText: string }).configText });
  }

  async function compare() {
    if (sel.length !== 2 || sel[0]!.switchId !== sel[1]!.switchId) return;
    setViewing(null);
    const r = await fetch(`/api/cisco/switches/${sel[0]!.switchId}/backups/${sel[0]!.id}/diff/${sel[1]!.id}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setDiff((await r.json()) as typeof diff);
  }

  async function del(row: CiscoBackupRow) {
    const r = await fetch(`/api/cisco/switches/${row.switchId}/backups/${row.id}`, { method: "DELETE", credentials: "same-origin" });
    if (r.ok) {
      setSel((prev) => prev.filter((s) => s.id !== row.id));
      await load();
    }
  }

  const sameSwitch = sel.length === 2 && sel[0]!.switchId === sel[1]!.switchId;

  const columns: Column<CiscoBackupRow>[] = [
    {
      key: "sel",
      label: "",
      render: (r) => (
        <input
          type="checkbox"
          checked={sel.some((s) => s.id === r.id)}
          onChange={() => toggleSel(r)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700"
          aria-label="select for compare"
        />
      ),
    },
    { key: "switch", label: "Switch", render: (r) => <span className="font-medium">{r.switchHostname}</span>, sortValue: (r) => r.switchHostname },
    { key: "at", label: "Backed up at", render: (r) => <span className="text-xs">{fmtTime(r.backedUpAt)}</span>, sortValue: (r) => new Date(r.backedUpAt).getTime() },
    { key: "type", label: "Type", render: (r) => <span className="text-xs capitalize">{r.backupType}</span>, sortValue: (r) => r.backupType },
    { key: "size", label: "Size", align: "right", render: (r) => <span className="text-xs">{fmtBytes(r.configSize)}</span>, sortValue: (r) => r.configSize },
    { key: "cksum", label: "Checksum", render: (r) => <span className="font-mono text-[10px] text-slate-500">{r.checksum.slice(0, 16)}…</span>, sortValue: (r) => r.checksum },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => void view(r)} className="text-xs text-brand-600 hover:underline dark:text-brand-400">
            {viewing?.id === r.id ? "Hide" : "View"}
          </button>
          {canWrite ? (
            <button type="button" onClick={() => void del(r)} className="text-xs text-rose-600 hover:underline dark:text-rose-400" aria-label="delete">
              <Trash2 className="inline h-3.5 w-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Config backups</h2>
      <DataTable
        rows={rows}
        columns={columns}
        getKey={(r) => r.id}
        initialSort={sort}
        initialPageSize={pageSize}
        filterPlaceholder="Search by switch, type, checksum…"
        emptyText="No backups yet. One is taken automatically on the next poll when a config changes."
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
        rightSlot={
          <>
            {sel.length === 2 && !sameSwitch ? (
              <span className="text-xs text-amber-600 dark:text-amber-400">Pick two backups from the same switch to compare</span>
            ) : null}
            <button
              type="button"
              onClick={() => void compare()}
              disabled={!sameSwitch}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              Compare ({sel.length}/2)
            </button>
          </>
        }
      />

      {diff ? (
        <div className="rounded-md border border-slate-300 dark:border-slate-800">
          <div className="flex items-center gap-3 border-b border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
            <span>
              Diff · <span className="text-emerald-600 dark:text-emerald-400">+{diff.added}</span> ·{" "}
              <span className="text-rose-600 dark:text-rose-400">−{diff.removed}</span>
            </span>
            <button type="button" onClick={() => setDiff(null)} className="ml-auto text-brand-600 hover:underline dark:text-brand-400">
              Close
            </button>
          </div>
          {diff.diff.length === 0 ? (
            <p className="p-4 text-sm text-emerald-700 dark:text-emerald-300">No differences.</p>
          ) : (
            <pre className="max-h-[28rem] overflow-auto font-mono text-xs">
              {diff.diff.map((d, i) => (
                <div
                  key={i}
                  className={
                    d.type === "added"
                      ? "bg-emerald-50 px-3 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : d.type === "removed"
                        ? "bg-rose-50 px-3 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                        : d.type === "separator"
                          ? "px-3 py-0.5 text-center text-slate-400"
                          : "px-3 text-slate-600 dark:text-slate-400"
                  }
                >
                  {d.type === "separator" ? d.line : `${d.type === "added" ? "+" : d.type === "removed" ? "-" : " "} ${d.line}`}
                </div>
              ))}
            </pre>
          )}
        </div>
      ) : null}

      {viewing ? (
        <div className="rounded-md border border-slate-300 dark:border-slate-800">
          <div className="flex items-center border-b border-slate-200 px-3 py-2 text-xs text-slate-500 dark:border-slate-800">
            <span>Config</span>
            <button type="button" onClick={() => setViewing(null)} className="ml-auto text-brand-600 hover:underline dark:text-brand-400">
              Close
            </button>
          </div>
          <pre className="max-h-[28rem] overflow-auto bg-slate-950 p-3 font-mono text-[11px] text-slate-200">{viewing.text}</pre>
        </div>
      ) : null}
    </div>
  );
}
