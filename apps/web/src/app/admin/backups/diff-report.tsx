"use client";

import { AlertTriangle, CheckCircle2, ShieldAlert, XCircle } from "lucide-react";
import type { BackupDiffReport, BackupDiffTable } from "@church/shared";
import { LocalDateTime } from "@/components/local-date-time";
import { formatBytes, formatCount } from "./client-api";

const WHEN: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

function Tile({ value, label, hint, tone }: { value: number; label: string; hint: string; tone: "green" | "red" | "amber" | "slate" }) {
  const tones = {
    green: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200",
    red: "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200",
    amber: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
    slate: "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
  };
  return (
    <div className={`rounded-md border p-3 ${tones[tone]}`}>
      <div className="text-2xl font-semibold tabular-nums">{formatCount(value)}</div>
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-0.5 text-xs opacity-80">{hint}</div>
    </div>
  );
}

function Pill({ n, text, tone }: { n: number; text: string; tone: "green" | "red" | "amber" }) {
  if (n === 0) return null;
  const tones = {
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    red: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  };
  return <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{formatCount(n)} {text}</span>;
}

function shown(v: string | null): string {
  return v === null ? "(empty)" : v;
}

function TableDetail({ t }: { t: BackupDiffTable }) {
  const moreAdded = t.added - t.samples.added.length;
  const moreRemoved = t.removed - t.samples.removed.length;
  const moreChanged = t.changed - t.samples.changed.length;
  return (
    <details className="group border-t border-slate-200 first:border-t-0 dark:border-slate-800" data-table={t.table}>
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900">
        <span className="font-medium">{t.title}</span>
        <span className="text-xs text-slate-500">
          {formatCount(t.currentRows)} now, {formatCount(t.backupRows)} in the backup
        </span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          <Pill n={t.added} text="brought back" tone="green" />
          <Pill n={t.removed} text="deleted" tone="red" />
          <Pill n={t.changed} text="put back as they were" tone="amber" />
        </span>
      </summary>
      <div className="space-y-3 px-3 pb-3 pt-1 text-sm">
        {t.samples.added.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Brought back (in the backup, missing now)</h4>
            <ul className="mt-1 list-disc pl-5">
              {t.samples.added.map((r) => (
                <li key={r.key}>{r.label}</li>
              ))}
              {moreAdded > 0 ? <li className="list-none text-xs text-slate-500">and {formatCount(moreAdded)} more</li> : null}
            </ul>
          </div>
        ) : null}
        {t.samples.removed.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">Deleted (made after the backup)</h4>
            <ul className="mt-1 list-disc pl-5">
              {t.samples.removed.map((r) => (
                <li key={r.key}>{r.label}</li>
              ))}
              {moreRemoved > 0 ? <li className="list-none text-xs text-slate-500">and {formatCount(moreRemoved)} more</li> : null}
            </ul>
          </div>
        ) : null}
        {t.samples.changed.length > 0 ? (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Put back as they were</h4>
            <div className="mt-1 space-y-2">
              {t.samples.changed.map((r) => (
                <div key={r.key} className="overflow-x-auto rounded border border-slate-200 dark:border-slate-800">
                  <div className="bg-slate-50 px-2 py-1 text-xs font-medium dark:bg-slate-900">{r.label}</div>
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="px-2 py-1 font-medium">Column</th>
                        <th className="px-2 py-1 font-medium">Now</th>
                        <th className="px-2 py-1 font-medium">In the backup</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.changes.map((c) => (
                        <tr key={c.column} className="border-t border-slate-100 align-top dark:border-slate-800">
                          <td className="px-2 py-1 font-mono">{c.column}</td>
                          {c.secret ? (
                            <td colSpan={2} className="px-2 py-1 italic text-slate-500">differs (secret, not shown)</td>
                          ) : (
                            <>
                              <td className="max-w-xs break-words px-2 py-1">{shown(c.current)}</td>
                              <td className="max-w-xs break-words px-2 py-1">{shown(c.backup)}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
              {moreChanged > 0 ? <p className="text-xs text-slate-500">and {formatCount(moreChanged)} more</p> : null}
            </div>
          </div>
        ) : null}
        {t.samples.added.length + t.samples.removed.length + t.samples.changed.length === 0 ? (
          <p className="text-xs text-slate-500">The affected rows are not described here (they are settings with no readable name).</p>
        ) : null}
      </div>
    </details>
  );
}

/** What restoring a backup would change, as the API worked it out. */
export function DiffReport({ report }: { report: BackupDiffReport }) {
  const { compatibility: c, totals, files } = report;
  const nothing = totals.added + totals.removed + totals.changed === 0 && (!files || files.added + files.removed === 0);
  return (
    <div className="space-y-4" data-testid="diff-report">
      <p className="text-sm text-slate-600 dark:text-slate-400">
        Compared with <strong>{report.backupName}</strong>, made <LocalDateTime value={report.backupCreatedAt} options={WHEN} />. This is what a restore would do to the data as it is now.
      </p>
      {report.scope.partial ? (
        <p className="rounded-md border border-brand-300 bg-brand-50 p-3 text-sm text-brand-900 dark:border-brand-800 dark:bg-brand-950/40 dark:text-brand-200" data-testid="scope-note">
          Only the sections you chose are compared and would be restored. Everything else stays <strong>exactly as it is now</strong>.
        </p>
      ) : null}

      {c.errors.length > 0 ? (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200" role="alert">
          <div className="flex items-center gap-2 font-medium">
            <XCircle aria-hidden className="h-4 w-4" /> This backup cannot be restored here
          </div>
          <ul className="mt-1 list-disc pl-6">
            {c.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {c.warnings.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle aria-hidden className="h-4 w-4" /> Things to know
          </div>
          <ul className="mt-1 list-disc pl-6">
            {c.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.you && report.you.status !== "unchanged" ? (
        <div
          className={`flex gap-2 rounded-md border p-3 text-sm ${
            report.you.status === "removed"
              ? "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          }`}
          data-testid="you-notice"
        >
          <ShieldAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{report.you.detail}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile value={totals.added} label="Brought back" hint="In the backup, missing now" tone="green" />
        <Tile value={totals.removed} label="Deleted" hint="Made after the backup" tone="red" />
        <Tile value={totals.changed} label="Put back as they were" hint="Edited since the backup" tone="amber" />
        <Tile value={totals.unchanged} label="Already identical" hint="Not touched" tone="slate" />
      </div>

      {nothing ? (
        <p className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          <CheckCircle2 aria-hidden className="h-4 w-4" /> The current data already matches this backup. A restore would change nothing.
        </p>
      ) : null}

      {report.groups.map((g) => (
        <section key={g.key} className="overflow-hidden rounded-md border border-slate-300 dark:border-slate-800">
          <h3 className="bg-slate-50 px-3 py-2 text-sm font-semibold dark:bg-slate-900">{g.title}</h3>
          {g.tables.map((t) => (
            <TableDetail key={t.table} t={t} />
          ))}
        </section>
      ))}

      {report.skipped.length > 0 ? (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="diff-skipped">
          <h3 className="font-semibold">Not restored: they depend on something that is not there</h3>
          <ul className="mt-1 list-disc pl-5">
            {report.skipped.map((n) => (
              <li key={`${n.table}-${n.reason}`}>
                <strong>{formatCount(n.count)}</strong> {n.table.toLowerCase()}: {n.reason}.
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.kept.length > 0 ? (
        <section className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200" data-testid="diff-kept">
          <h3 className="font-semibold">Kept although they are not in the backup</h3>
          <ul className="mt-1 list-disc pl-5">
            {report.kept.map((n) => (
              <li key={`${n.table}-${n.reason}`}>
                <strong>{formatCount(n.count)}</strong> {n.table.toLowerCase()}: {n.reason}.
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {files ? (
        <section className="rounded-md border border-slate-300 p-3 text-sm dark:border-slate-800" data-testid="diff-files">
          <h3 className="font-semibold">Uploaded files</h3>
          {files.added + files.removed === 0 ? (
            <p className="mt-1 text-slate-600 dark:text-slate-400">The files in storage are the same as in the backup.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {files.added > 0 ? (
                <li>
                  <span className="font-medium text-emerald-700 dark:text-emerald-400">{formatCount(files.added)}</span> file{files.added === 1 ? "" : "s"} ({formatBytes(files.addedBytes)}) will be put back into storage
                  {files.samples.added.length > 0 ? <span className="text-xs text-slate-500"> - e.g. {files.samples.added.slice(0, 3).join(", ")}</span> : null}
                </li>
              ) : null}
              {files.removed > 0 ? (
                <li>
                  <span className="font-medium text-rose-700 dark:text-rose-400">{formatCount(files.removed)}</span> file{files.removed === 1 ? "" : "s"} ({formatBytes(files.removedBytes)}) uploaded since will be deleted from storage
                  {files.samples.removed.length > 0 ? <span className="text-xs text-slate-500"> - e.g. {files.samples.removed.slice(0, 3).join(", ")}</span> : null}
                </li>
              ) : null}
            </ul>
          )}
        </section>
      ) : null}

      {report.identicalTables.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-400">{report.identicalTables.length} kinds of data are identical and would not change</summary>
          <p className="mt-1 text-xs text-slate-500">{report.identicalTables.join(", ")}</p>
        </details>
      ) : null}
    </div>
  );
}
