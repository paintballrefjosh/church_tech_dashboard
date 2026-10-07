"use client";

import { Loader2 } from "lucide-react";
import type { BackupOperation } from "@church/shared";

/** What a running operation is doing, with a bar when it knows how far along it is. */
export function OperationProgress({ op, title }: { op: BackupOperation; title?: string }) {
  const p = op.progress;
  const pct = p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
  return (
    <div className="rounded-md border border-brand-300 bg-brand-50 p-3 text-sm dark:border-brand-800 dark:bg-brand-950/40" role="status" aria-live="polite" data-testid="operation-progress">
      <div className="flex items-center gap-2 font-medium text-brand-800 dark:text-brand-200">
        <Loader2 aria-hidden className="h-4 w-4 animate-spin" />
        {title ?? op.phase ?? "Working"}
      </div>
      <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
        {p ? p.label : op.phase}
        {pct !== null ? ` (${pct}%)` : ""}
      </p>
      {pct !== null ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded bg-brand-100 dark:bg-brand-900">
          <div className="h-full bg-brand-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300" role="alert">
      {children}
    </p>
  );
}
