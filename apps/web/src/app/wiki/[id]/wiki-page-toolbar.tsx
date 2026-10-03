"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, History, Trash2, FileLock, Globe } from "lucide-react";
import type { WikiVisibility } from "@church/shared";

interface AclRow {
  groupId: string;
  groupName: string;
  canEdit: boolean;
}

/**
 * Row of page-level actions + metadata, rendered just above the body on the
 * view page (used to live in a separate right-hand info column).
 */
export function WikiPageToolbar({
  pageId,
  canEdit,
  canDelete,
  visibility,
  acl,
}: {
  pageId: string;
  canEdit: boolean;
  canDelete: boolean;
  visibility: WikiVisibility;
  acl: AclRow[];
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
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
      {canEdit ? (
        <Link
          href={`/wiki/${pageId}/edit`}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
        >
          <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit
        </Link>
      ) : null}
      <Link
        href={`/wiki/${pageId}/revisions`}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        <History className="h-3.5 w-3.5" aria-hidden /> History
      </Link>
      {canDelete ? (
        <button
          type="button"
          onClick={() => void destroy()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-60 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-950"
        >
          <Trash2 className="h-3.5 w-3.5" aria-hidden /> {busy ? "Deleting…" : "Delete"}
        </button>
      ) : null}
      {!canEdit && !canDelete ? (
        <span className="text-xs text-slate-500 dark:text-slate-400">Read-only</span>
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${
            visibility === "group"
              ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
          }`}
        >
          {visibility === "group" ? (
            <FileLock className="h-3 w-3" aria-hidden />
          ) : (
            <Globe className="h-3 w-3" aria-hidden />
          )}
          {visibility === "group" ? "Restricted" : "Public"}
        </span>
        {acl.length ? (
          <span
            title={acl.map((a) => `${a.groupName} (${a.canEdit ? "read + edit" : "read"})`).join(", ")}
          >
            {acl.map((a) => a.groupName).join(", ")}
          </span>
        ) : null}
      </div>
    </div>
  );
}
