"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CiscoVlanRow } from "@church/shared";
import { DataTable, type Column } from "@/components/data-table";

export default function CiscoVlansPage() {
  const [vlans, setVlans] = useState<CiscoVlanRow[] | null>(null);
  const [conflictsOnly, setConflictsOnly] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/cisco/vlans", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setVlans((await r.json()) as CiscoVlanRow[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!vlans) return <p className="text-sm text-slate-500">Loading…</p>;

  const conflicts = vlans.filter((v) => v.nameConflict).length;
  const rows = conflictsOnly ? vlans.filter((v) => v.nameConflict) : vlans;

  const columns: Column<CiscoVlanRow>[] = [
    { key: "vlanId", label: "VLAN ID", render: (v) => <span className="font-mono font-semibold">{v.vlanId}</span>, sortValue: (v) => v.vlanId },
    {
      key: "name",
      label: "Name",
      render: (v) =>
        v.nameConflict ? (
          <span className="space-x-2 text-xs">
            {[...new Set(v.switches.map((s) => s.vlanName ?? "unnamed"))].map((name) => (
              <span key={name} className="text-orange-700 dark:text-orange-300">
                {name}
              </span>
            ))}
            <span className="rounded bg-orange-100 px-1.5 text-[10px] text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">conflict</span>
          </span>
        ) : (
          <span className="text-xs">{v.switches[0]?.vlanName ?? "unnamed"}</span>
        ),
      sortValue: (v) => [...new Set(v.switches.map((s) => s.vlanName ?? "unnamed"))].join(" "),
    },
    {
      key: "switches",
      label: "Switches",
      render: (v) => (
        <div className="flex flex-wrap gap-1">
          {v.switches.map((s) => (
            <span key={s.switchId} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {s.hostname}
            </span>
          ))}
        </div>
      ),
      sortValue: (v) => v.switches.map((s) => s.hostname).join(" "),
    },
    {
      key: "status",
      label: "Status",
      render: (v) =>
        v.switches.every((s) => s.vlanStatus === "active") ? (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">active</span>
        ) : (
          <span className="text-xs text-slate-500">mixed</span>
        ),
      sortValue: (v) => (v.switches.every((s) => s.vlanStatus === "active") ? "active" : "mixed"),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">VLAN database</h2>
        {conflicts > 0 ? (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-900/40 dark:text-orange-300">
            {conflicts} name conflict{conflicts === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        getKey={(v) => String(v.vlanId)}
        initialSort={{ key: "vlanId", dir: "asc" }}
        initialPageSize={50}
        filterPlaceholder="Search by VLAN id, name, or switch…"
        emptyText="No VLANs found. Run a poll to collect VLAN data."
        rightSlot={
          <>
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
              <input type="checkbox" checked={conflictsOnly} onChange={(e) => setConflictsOnly(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700" />
              Conflicts only
            </label>
            <button type="button" onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
              <RefreshCw className="h-4 w-4" aria-hidden /> Refresh
            </button>
          </>
        }
      />
    </div>
  );
}
