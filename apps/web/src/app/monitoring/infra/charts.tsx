"use client";

import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import type { InfraMetricPoint } from "@church/shared";

/**
 * A single-metric line chart over a time window. Recharts needs a real width to
 * render, which Next 15 SSR doesn't provide (width 0), so we defer mounting the
 * ResponsiveContainer until the client has painted. Ticks use a neutral slate
 * that reads in both light and dark themes.
 */
export function MetricChart({
  points,
  field,
  color,
  title,
  unit = "%",
  domainMax,
  height = 180,
}: {
  points: InfraMetricPoint[];
  field: "cpuPct" | "memPct" | "diskPctMax";
  color: string;
  title: string;
  unit?: string;
  domainMax?: number;
  height?: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const data = points.map((p) => ({ t: Date.parse(p.ts), v: p[field] }));
  const hasData = data.some((d) => d.v !== null && d.v !== undefined);

  return (
    <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
        <span className="text-xs text-slate-400">
          {hasData ? `${round(data[data.length - 1]?.v)}${unit}` : "—"}
        </span>
      </div>
      <div style={{ height }}>
        {mounted && hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid stroke="#64748b" strokeOpacity={0.15} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={fmtTime}
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                minTickGap={40}
                stroke="#94a3b8"
              />
              <YAxis
                domain={[0, domainMax ?? "auto"]}
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                width={46}
                stroke="#94a3b8"
                tickFormatter={(v: number) => `${Math.round(v)}`}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "#0f172a",
                  color: "#e2e8f0",
                }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                formatter={(v: number) => [`${round(v)}${unit}`, title]}
              />
              <Line
                type="monotone"
                dataKey="v"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-400">
            {mounted ? "No data in this range yet." : ""}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A multi-series line chart over a time window, for facets that aren't one of
 * the three promoted scalars (network throughput, load average, disk IO,
 * temperature). Each series pulls its value from a point via `valueOf`, which
 * lets the caller paper over the raw-vs-rollup shape difference in
 * `point.metrics`. `format` renders both the tooltip and the current-value
 * readout (e.g. bytes-per-sec). Same deferred-mount + connectNulls treatment as
 * MetricChart.
 */
export interface Series {
  name: string;
  color: string;
  valueOf: (p: InfraMetricPoint) => number | null;
}

export function MultiSeriesChart({
  points,
  series,
  title,
  format = (v) => String(Math.round(v * 10) / 10),
  domainMax,
  height = 180,
}: {
  points: InfraMetricPoint[];
  series: Series[];
  title: string;
  format?: (v: number) => string;
  domainMax?: number;
  height?: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const data = points.map((p) => {
    const row: Record<string, number | null> = { t: Date.parse(p.ts) };
    for (const s of series) row[s.name] = s.valueOf(p);
    return row;
  });
  const hasData = data.some((d) => series.some((s) => d[s.name] !== null && d[s.name] !== undefined));

  return (
    <div className="rounded-md border border-slate-300 p-3 dark:border-slate-800">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      </div>
      <div style={{ height }}>
        {mounted && hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -10 }}>
              <CartesianGrid stroke="#64748b" strokeOpacity={0.15} vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={fmtTime}
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                minTickGap={40}
                stroke="#94a3b8"
              />
              <YAxis
                domain={[0, domainMax ?? "auto"]}
                tick={{ fontSize: 10, fill: "#94a3b8" }}
                width={46}
                stroke="#94a3b8"
                tickFormatter={(v: number) => format(v)}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 6,
                  border: "1px solid #334155",
                  background: "#0f172a",
                  color: "#e2e8f0",
                }}
                labelFormatter={(t) => new Date(Number(t)).toLocaleString()}
                formatter={(v: number, name: string) => [format(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} iconType="plainline" />
              {series.map((s) => (
                <Line
                  key={s.name}
                  type="monotone"
                  dataKey={s.name}
                  name={s.name}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-slate-400">
            {mounted ? "No data in this range yet." : ""}
          </div>
        )}
      </div>
    </div>
  );
}

function fmtTime(t: number): string {
  const d = new Date(t);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function round(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return String(Math.round(v * 10) / 10);
}
