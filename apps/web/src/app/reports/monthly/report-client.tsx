"use client";

import { useEffect, useState } from "react";
import { monthTitle, type MonthlyReport } from "@church/shared";

function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const card = "rounded-md border border-slate-300 p-4 dark:border-slate-800";
const th = "px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";

export function ReportClient({ initialMonth }: { initialMonth: string | null }) {
  const [month, setMonth] = useState(initialMonth ?? lastMonth());
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    fetch(`/api/v1/reports/monthly?month=${month}`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 403) return setError("The monthly report is for site admins and the group it is sent to.");
        if (!r.ok) return setError(`The report could not be made (${r.status}).`);
        setReport((await r.json()) as MonthlyReport);
      })
      .catch(() => !cancelled && setError("The report could not be loaded."));
    return () => {
      cancelled = true;
    };
  }, [month]);

  return (
    <div className="mt-6 space-y-5 text-sm">
      <label className="inline-flex items-center gap-2">
        <span>Month</span>
        <input
          type="month"
          value={month}
          onChange={(e) => e.target.value && setMonth(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      {error ? <p className={`${card} text-rose-700 dark:text-rose-300`}>{error}</p> : null}
      {!report && !error ? <p className="text-slate-500 dark:text-slate-400">Loading…</p> : null}
      {report ? (
        <>
          <h2 className="text-xl font-semibold">{monthTitle(report.month)}</h2>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className={card}>
              <div className="text-xs text-slate-500 dark:text-slate-400">Incidents</div>
              <div className="text-2xl font-semibold">{report.incidents.total}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{report.incidents.acknowledged} acknowledged</div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500 dark:text-slate-400">Tickets opened / resolved</div>
              <div className="text-2xl font-semibold">
                {report.tickets.opened} / {report.tickets.resolved}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{report.tickets.openAtEnd} open at the end of the month</div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500 dark:text-slate-400">Median time to resolve</div>
              <div className="text-2xl font-semibold">{report.tickets.medianResolutionHours === null ? "—" : `${report.tickets.medianResolutionHours} h`}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                SLA breaches: {report.tickets.responseBreaches} response, {report.tickets.resolutionBreaches} resolution
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-slate-500 dark:text-slate-400">Backups made</div>
              <div className="text-2xl font-semibold">{report.backups.succeeded}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{report.backups.failed ? `${report.backups.failed} failed` : "none failed"}</div>
            </div>
          </div>

          <section className={card} aria-labelledby="svc-h">
            <h3 id="svc-h" className="font-semibold">
              Services
            </h3>
            {report.services.length === 0 ? (
              <p className="mt-2 text-slate-500 dark:text-slate-400">No monitors.</p>
            ) : (
              <div className="mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Uptime by service">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className={th}>Service</th>
                      <th className={`${th} text-right`}>Uptime</th>
                      <th className={`${th} text-right`}>Incidents</th>
                      <th className={`${th} text-right`}>Longest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                    {report.services.map((s) => (
                      <tr key={s.name}>
                        <td className="px-3 py-1.5">{s.name}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${s.uptime < 99 ? "font-semibold text-rose-700 dark:text-rose-300" : ""}`}>{s.uptime}%</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{s.incidents}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{s.longestMinutes ? `${s.longestMinutes} min` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className={card} aria-labelledby="ren-h">
            <h3 id="ren-h" className="font-semibold">
              Renewing next month
            </h3>
            {report.renewalsNextMonth.length === 0 ? (
              <p className="mt-2 text-slate-500 dark:text-slate-400">Nothing recorded.</p>
            ) : (
              <ul className="mt-2 list-disc pl-5">
                {report.renewalsNextMonth.map((r) => (
                  <li key={`${r.name}${r.renewsOn}`}>
                    {r.name}: {r.renewsOn}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
