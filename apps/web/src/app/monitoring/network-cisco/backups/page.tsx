"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Download, Loader2, Trash2 } from "lucide-react";
import type { CiscoBackupRow, CiscoBackupDiffLine } from "@church/shared";
import { useCanWrite, fmtBytes, fmtTime, BigModal } from "../cisco-ui";
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
  // The config being viewed: opens at once (text null while it loads) in a large modal.
  const [viewing, setViewing] = useState<{ row: CiscoBackupRow; text: string | null; error: string | null } | null>(null);
  const [diff, setDiff] = useState<{ diff: CiscoBackupDiffLine[]; added: number; removed: number; title: string } | null>(null);
  const [comparing, setComparing] = useState(false);
  const [copied, setCopied] = useState(false);

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
    setCopied(false);
    setViewing({ row, text: null, error: null });
    try {
      const r = await fetch(`/api/cisco/switches/${row.switchId}/backups/${row.id}`, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(`Could not load the config (${r.status})`);
      const text = ((await r.json()) as { configText: string }).configText;
      setViewing((v) => (v?.row.id === row.id ? { row, text, error: null } : v));
    } catch (e) {
      setViewing((v) => (v?.row.id === row.id ? { row, text: null, error: e instanceof Error ? e.message : "Could not load the config" } : v));
    }
  }

  async function compare() {
    if (sel.length !== 2 || sel[0]!.switchId !== sel[1]!.switchId || comparing) return;
    setViewing(null);
    setComparing(true);
    try {
      const r = await fetch(`/api/cisco/switches/${sel[0]!.switchId}/backups/${sel[0]!.id}/diff/${sel[1]!.id}`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (r.ok) {
        const a = rows.find((x) => x.id === sel[0]!.id);
        const b = rows.find((x) => x.id === sel[1]!.id);
        const d = (await r.json()) as Omit<NonNullable<typeof diff>, "title">;
        setDiff({ ...d, title: `${a?.switchHostname ?? "Switch"}: ${a ? fmtTime(a.backedUpAt) : "?"} vs ${b ? fmtTime(b.backedUpAt) : "?"}` });
      }
    } finally {
      setComparing(false);
    }
  }

  async function copyConfig() {
    if (!viewing?.text) return;
    try {
      await navigator.clipboard.writeText(viewing.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable (not a secure context): the text is selectable */
    }
  }

  function downloadConfig() {
    if (!viewing?.text) return;
    const name = `${viewing.row.switchHostname}-${new Date(viewing.row.backedUpAt).toISOString().replace(/[:T]/g, "-").slice(0, 16)}.cfg`;
    const url = URL.createObjectURL(new Blob([viewing.text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name.replace(/[^A-Za-z0-9._-]/g, "_");
    a.click();
    URL.revokeObjectURL(url);
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
      srLabel: "Select for compare",
      render: (r) => (
        <input
          type="checkbox"
          checked={sel.some((s) => s.id === r.id)}
          onChange={() => toggleSel(r)}
          className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:text-brand-400 dark:border-slate-700"
          aria-label="select for compare"
        />
      ),
    },
    { key: "switch", label: "Switch", render: (r) => <span className="font-medium">{r.switchHostname}</span>, sortValue: (r) => r.switchHostname },
    { key: "at", label: "Backed up at", render: (r) => <span className="text-xs">{fmtTime(r.backedUpAt)}</span>, sortValue: (r) => new Date(r.backedUpAt).getTime() },
    { key: "type", label: "Type", render: (r) => <span className="text-xs capitalize">{r.backupType}</span>, sortValue: (r) => r.backupType },
    { key: "size", label: "Size", align: "right", render: (r) => <span className="text-xs">{fmtBytes(r.configSize)}</span>, sortValue: (r) => r.configSize },
    { key: "cksum", label: "Checksum", render: (r) => <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{r.checksum.slice(0, 16)}…</span>, sortValue: (r) => r.checksum },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => void view(r)} className="text-xs text-brand-600 hover:underline dark:text-brand-400">
            View
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
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Config backups</h2>
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
              <span className="text-xs text-amber-700 dark:text-amber-400">Pick two backups from the same switch to compare</span>
            ) : null}
            <button
              type="button"
              onClick={() => void compare()}
              disabled={!sameSwitch || comparing}
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
            >
              Compare ({sel.length}/2)
            </button>
          </>
        }
      />

      {diff ? (
        <BigModal
          title="Config comparison"
          subtitle={
            <>
              {diff.title} · <span className="text-emerald-700 dark:text-emerald-400">+{diff.added}</span> ·{" "}
              <span className="text-rose-600 dark:text-rose-400">−{diff.removed}</span>
            </>
          }
          onClose={() => setDiff(null)}
        >
          {diff.diff.length === 0 ? (
            <p className="p-6 text-sm text-emerald-700 dark:text-emerald-300">No differences.</p>
          ) : (
            <pre className="font-mono text-xs leading-relaxed">
              {diff.diff.map((d, i) => (
                <div
                  key={i}
                  className={
                    d.type === "added"
                      ? "bg-emerald-50 px-4 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
                      : d.type === "removed"
                        ? "bg-rose-50 px-4 text-rose-800 dark:bg-rose-950/40 dark:text-rose-300"
                        : d.type === "separator"
                          ? "px-4 py-0.5 text-center text-slate-500 dark:text-slate-400"
                          : "px-4 text-slate-600 dark:text-slate-400"
                  }
                >
                  {d.type === "separator" ? d.line : `${d.type === "added" ? "+" : d.type === "removed" ? "-" : " "} ${d.line}`}
                </div>
              ))}
            </pre>
          )}
        </BigModal>
      ) : null}

      {viewing ? (
        <BigModal
          title={`${viewing.row.switchHostname} config`}
          subtitle={
            <>
              {viewing.row.backupType} backup · {fmtTime(viewing.row.backedUpAt)} · {fmtBytes(viewing.row.configSize)}
              {viewing.text !== null ? ` · ${viewing.text.split("\n").length} lines` : ""}
            </>
          }
          actions={
            <>
              <button
                type="button"
                onClick={() => void copyConfig()}
                disabled={viewing.text === null}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-400" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </button>
              <button
                type="button"
                onClick={downloadConfig}
                disabled={viewing.text === null}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5" aria-hidden /> Download
              </button>
            </>
          }
          onClose={() => setViewing(null)}
        >
          {viewing.error ? (
            <p className="p-6 text-sm text-rose-600 dark:text-rose-400">{viewing.error}</p>
          ) : viewing.text === null ? (
            <p className="flex items-center gap-2 p-6 text-sm text-slate-500 dark:text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading the config…
            </p>
          ) : (
            <pre className="min-h-full bg-slate-950 p-4 font-mono text-[12px] leading-relaxed text-slate-200">{viewing.text}</pre>
          )}
        </BigModal>
      ) : null}
    </div>
  );
}
