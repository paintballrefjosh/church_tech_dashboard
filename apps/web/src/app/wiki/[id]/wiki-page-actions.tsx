"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function WikiPageActions({
  pageId,
  canEdit,
  canDelete,
}: {
  pageId: string;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function destroy() {
    if (!confirm("Delete this page? This cannot be undone.")) return;
    setBusy(true);
    const res = await fetch(`/api/wiki/${pageId}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    if (res.ok) router.push("/wiki");
    else {
      alert(`Delete failed (${res.status})`);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {canEdit ? (
        <Link
          href={`/wiki/${pageId}/edit`}
          className="block w-full rounded-md bg-brand-600 px-3 py-1.5 text-center text-sm font-medium text-white hover:bg-brand-700"
        >
          Edit
        </Link>
      ) : null}
      {canDelete ? (
        <button
          type="button"
          onClick={destroy}
          disabled={busy}
          className="block w-full rounded-md border border-rose-300 px-3 py-1.5 text-center text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-700 dark:hover:bg-rose-950"
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      ) : null}
      {!canEdit && !canDelete ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">Read-only.</p>
      ) : null}
    </div>
  );
}
