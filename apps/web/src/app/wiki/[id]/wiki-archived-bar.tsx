"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { LocalDateTime } from "@/components/local-date-time";

/**
 * Shown under the title of an archived page: the page is still here and readable, it is just left out of the wiki menu and
 * comes last in searches. Whoever may edit the page can bring it back.
 */
export function WikiArchivedBar({
  pageId,
  canEdit,
  archivedAt,
  archivedBy,
}: {
  pageId: string;
  canEdit: boolean;
  archivedAt: string;
  archivedBy: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/wiki/${pageId}/unarchive`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) {
        setError(`Could not restore it (${res.status})`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="archived-banner"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-md border border-slate-300 bg-slate-100 px-3 py-2 text-sm text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
    >
      <Archive className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        This page is archived
        <span className="text-slate-600 dark:text-slate-300">
          {" "}
          (<LocalDateTime value={archivedAt} />
          {archivedBy ? <> by {archivedBy}</> : null}). It is left out of the wiki menu and comes last in searches.
        </span>
        {error ? <span className="ml-2 text-rose-700 dark:text-rose-300">{error}</span> : null}
      </span>
      {canEdit ? (
        <button
          type="button"
          onClick={() => void restore()}
          disabled={busy}
          data-testid="wiki-unarchive"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-400 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-500 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-700"
        >
          <ArchiveRestore className="h-3.5 w-3.5" aria-hidden /> {busy ? "Restoring..." : "Unarchive"}
        </button>
      ) : null}
    </div>
  );
}
