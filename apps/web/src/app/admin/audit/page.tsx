import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ScrollText, Search, Download } from "lucide-react";
import type { AuditEntry } from "@church/shared";
import { AuditTable } from "./audit-table";

type SearchParams = {
  actor?: string;
  resource?: string;
  action?: string;
  from?: string;
  to?: string;
};

export default async function AuditPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const sp = await searchParams;
  const q = new URLSearchParams();
  q.set("limit", "100");
  if (sp.actor) q.set("actorUserId", sp.actor);
  if (sp.resource) q.set("resourceType", sp.resource);
  if (sp.action) q.set("action", sp.action);
  if (sp.from) q.set("from", sp.from);
  if (sp.to) q.set("to", sp.to);

  let items: AuditEntry[] = [];
  let error: string | null = null;
  try {
    const body = await apiJson<{ items: AuditEntry[] }>(`/api/v1/audit?${q.toString()}`);
    items = body.items;
  } catch (e) {
    error = (e as Error).message;
  }

  // CSV export goes straight at the API through Caddy. The browser's session
  // cookie is on the same origin so the api's SessionGuard sees it; the
  // controller enforces audit:read:any. Limit is bumped so an export covers
  // more than the on-screen 100.
  const csvParams = new URLSearchParams(q);
  csvParams.set("limit", "10000");
  const csvHref = `/api/v1/audit/export.csv?${csvParams.toString()}`;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={ScrollText}>Audit log</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          The 100 most recent entries matching the filters below.
        </p>

        <form className="mt-6 flex flex-wrap items-end gap-3 text-sm">
          <label className="flex flex-col">
            <span className="text-xs text-slate-500">Resource type</span>
            <input
              type="text"
              name="resource"
              defaultValue={sp.resource ?? ""}
              placeholder="ticket, wiki_page, user, …"
              className="mt-1 w-48 rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500">Action</span>
            <input
              type="text"
              name="action"
              defaultValue={sp.action ?? ""}
              placeholder="ticket.update, wiki.delete, …"
              className="mt-1 w-56 rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500">Actor user-id</span>
            <input
              type="text"
              name="actor"
              defaultValue={sp.actor ?? ""}
              placeholder="UUID"
              className="mt-1 w-72 rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500">From</span>
            <input
              type="date"
              name="from"
              defaultValue={sp.from ?? ""}
              className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500">To</span>
            <input
              type="date"
              name="to"
              defaultValue={sp.to ?? ""}
              className="mt-1 w-40 rounded-md border border-slate-300 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900"
            />
          </label>
          <button
            type="submit"
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-white hover:bg-brand-700"
          >
            <Search className="h-4 w-4" aria-hidden /> Apply
          </button>
          <a
            href={csvHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            data-testid="audit-export-csv"
          >
            <Download className="h-4 w-4" aria-hidden /> Export CSV
          </a>
        </form>

        {error ? (
          <p
            className="mt-6 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-900/30 dark:text-rose-300"
            data-testid="audit-error"
          >
            {error}
          </p>
        ) : (
          <div className="mt-6">
            <AuditTable items={items} />
          </div>
        )}
      </main>
    </>
  );
}
