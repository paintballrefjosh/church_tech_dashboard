"use client";

import { useEffect, useMemo, useState } from "react";
import type { CiscoTopology } from "@church/shared";
import { DataTable, type Column } from "@/components/data-table";

type EdgeRow = CiscoTopology["edges"][number] & { _key: string };

export default function CiscoTopologyPage() {
  const [topo, setTopo] = useState<CiscoTopology | null>(null);

  useEffect(() => {
    fetch("/api/cisco/topology", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((t: CiscoTopology | null) => setTopo(t))
      .catch(() => undefined);
  }, []);

  const layout = useMemo(() => {
    if (!topo) return null;
    const W = 760;
    const H = 460;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 70;
    const n = topo.nodes.length;
    const pos = new Map<string, { x: number; y: number }>();
    topo.nodes.forEach((node, i) => {
      if (n === 1) {
        pos.set(node.id, { x: cx, y: cy });
      } else {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        pos.set(node.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
      }
    });
    return { W, H, pos };
  }, [topo]);

  if (!topo) return <p className="text-sm text-slate-500">Loading…</p>;

  if (topo.nodes.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
        No topology yet. Neighbors are discovered via LLDP/CDP on each poll — add switches and let them poll.
      </p>
    );
  }

  const color = (kind: string, reachable?: boolean) =>
    kind === "external" ? "#94a3b8" : reachable === false ? "#f43f5e" : "#10b981";

  const edgeRows: EdgeRow[] = topo.edges.map((e, i) => ({ ...e, _key: `${e.a}-${e.aPort ?? ""}-${e.b}-${e.bPort ?? ""}-${i}` }));
  const edgeColumns: Column<EdgeRow>[] = [
    { key: "a", label: "Switch", render: (e) => <span className="font-medium">{e.a}</span>, sortValue: (e) => e.a },
    { key: "aPort", label: "Local port", render: (e) => <span className="font-mono text-xs">{e.aPort ?? "—"}</span>, sortValue: (e) => e.aPort ?? "" },
    { key: "b", label: "Neighbor", render: (e) => <span>{e.b}</span>, sortValue: (e) => e.b },
    { key: "bPort", label: "Neighbor port", render: (e) => <span className="font-mono text-xs">{e.bPort ?? "—"}</span>, sortValue: (e) => e.bPort ?? "" },
    { key: "protocol", label: "Protocol", render: (e) => <span className="text-xs uppercase text-slate-500">{e.protocol ?? "—"}</span>, sortValue: (e) => e.protocol ?? "" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Topology</h2>
        <span className="text-xs text-slate-400">
          {topo.nodes.length} node{topo.nodes.length === 1 ? "" : "s"} · {topo.edges.length} link
          {topo.edges.length === 1 ? "" : "s"} (LLDP/CDP)
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          <Legend color="#10b981" label="Switch (up)" />
          <Legend color="#f43f5e" label="Switch (down)" />
          <Legend color="#94a3b8" label="External" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
        {layout ? (
          <svg viewBox={`0 0 ${layout.W} ${layout.H}`} className="mx-auto block w-full max-w-3xl">
            {topo.edges.map((e, i) => {
              const a = layout.pos.get(e.a);
              const b = layout.pos.get(e.b);
              if (!a || !b) return null;
              return (
                <g key={i}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#cbd5e1" strokeWidth={1.5} />
                  <title>
                    {e.a} ({e.aPort ?? "?"}) ↔ {e.b} ({e.bPort ?? "?"}) · {e.protocol ?? ""}
                  </title>
                </g>
              );
            })}
            {topo.nodes.map((node) => {
              const p = layout.pos.get(node.id)!;
              return (
                <g key={node.id}>
                  <circle cx={p.x} cy={p.y} r={9} fill={color(node.kind, node.reachable)} stroke="#fff" strokeWidth={1.5} />
                  <text x={p.x} y={p.y - 14} textAnchor="middle" className="fill-slate-600 text-[10px] dark:fill-slate-300">
                    {node.label}
                  </text>
                </g>
              );
            })}
          </svg>
        ) : null}
      </div>

      {topo.edges.length > 0 ? (
        <DataTable
          rows={edgeRows}
          columns={edgeColumns}
          getKey={(e) => e._key}
          initialSort={{ key: "a", dir: "asc" }}
          initialPageSize={50}
          filterPlaceholder="Search by switch, port, neighbor…"
          emptyText="No links discovered."
        />
      ) : null}
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
