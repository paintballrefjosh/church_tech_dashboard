"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, History, Trash2, FileLock, Globe, LayoutTemplate } from "lucide-react";
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
  isAdmin,
  visibility,
  acl,
}: {
  pageId: string;
  canEdit: boolean;
  canDelete: boolean;
  /** A wiki admin: may keep the list of page templates. */
  isAdmin: boolean;
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

  async function saveAsTemplate() {
    if (!confirm("Save this page's text as a page template that everyone who writes in the wiki can start from?")) return;
    setBusy(true);
    try {
      const page = await fetch(`/api/v1/wiki/${pageId}`, { credentials: "same-origin", cache: "no-store" });
      if (!page.ok) throw new Error(String(page.status));
      const p = (await page.json()) as { page: { title: string; body: string } };
      const res = await fetch("/api/v1/wiki/templates", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: p.page.title.slice(0, 80), description: "", body: p.page.body }),
      });
      if (!res.ok) throw new Error(String(res.status));
      router.push("/wiki/templates");
    } catch (e) {
      alert(`Could not save the template (${(e as Error).message})`);
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
      {isAdmin ? (
        <button
          type="button"
          onClick={() => void saveAsTemplate()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          <LayoutTemplate className="h-3.5 w-3.5" aria-hidden /> Save as template
        </button>
      ) : null}
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
