"use client";

import { Fragment, useState } from "react";
import type { AuditEntry } from "@church/shared";

export function AuditTable({ items }: { items: AuditEntry[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <p className="rounded-md border border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-800">
        No audit entries match these filters.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
      <table className="w-full text-left text-sm" data-testid="audit-table">
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2">When</th>
            <th className="px-3 py-2">Actor</th>
            <th className="px-3 py-2">Action</th>
            <th className="px-3 py-2">Resource</th>
            <th className="px-3 py-2">IP</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
          {items.map((e) => {
            const open = expanded === e.id;
            const hasDiff = e.before != null || e.after != null;
            return (
              <Fragment key={e.id}>
                <tr className="align-top">
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(e.ts).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.actorEmail ?? <span className="text-slate-400">(system)</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {e.resourceType}
                    {e.resourceId ? (
                      <span className="block text-[10px] text-slate-400">{e.resourceId}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">{e.ip ?? ""}</td>
                  <td className="px-3 py-2 text-right">
                    {hasDiff ? (
                      <button
                        type="button"
                        onClick={() => setExpanded(open ? null : e.id)}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        {open ? "Hide" : "Diff"}
                      </button>
                    ) : null}
                  </td>
                </tr>
                {open && hasDiff ? (
                  <tr>
                    <td colSpan={6} className="bg-slate-50 px-3 py-3 dark:bg-slate-900">
                      <div className="grid gap-3 md:grid-cols-2">
                        <pre className="overflow-auto rounded bg-white p-2 text-[11px] dark:bg-slate-950">
                          <div className="mb-1 text-xs font-semibold text-slate-500">before</div>
                          {fmt(e.before)}
                        </pre>
                        <pre className="overflow-auto rounded bg-white p-2 text-[11px] dark:bg-slate-950">
                          <div className="mb-1 text-xs font-semibold text-slate-500">after</div>
                          {fmt(e.after)}
                        </pre>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return "(none)";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
