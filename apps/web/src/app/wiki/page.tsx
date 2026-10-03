import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";
import { BookOpen, Plus, FileLock, FileUp } from "lucide-react";
import type { WikiPage, WikiTreeNode } from "@church/shared";
import { WikiSearch } from "./wiki-search";
import { WikiTagFilter } from "./tag-filter-island";
import { WikiTreeSidebar } from "./wiki-tree-sidebar";
import { WikiSidebarPane } from "./wiki-sidebar-pane";

export const dynamic = "force-dynamic";

export default async function WikiListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tag?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (params.tag) qs.set("tagId", params.tag);
  const url = `/api/v1/wiki${qs.toString() ? `?${qs}` : ""}`;
  const [pages, tree] = await Promise.all([
    apiJson<WikiPage[]>(url).catch(() => [] as WikiPage[]),
    apiJson<WikiTreeNode[]>("/api/v1/wiki/tree").catch(() => [] as WikiTreeNode[]),
  ]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={BookOpen}>Wiki</PageTitle>
          <div className="ml-auto flex items-center gap-2">
            <WikiSearch defaultValue={q} />
            <Link
              href="/wiki/import"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-900"
            >
              <FileUp className="h-4 w-4" aria-hidden /> Import file
            </Link>
            <Link
              href="/wiki/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> New page
            </Link>
          </div>
        </header>

        <WikiTagFilter />

        <div className="gap-6 md:flex">
          <WikiSidebarPane>
            <WikiTreeSidebar tree={tree} />
          </WikiSidebarPane>
          <section className="mt-6 min-w-0 flex-1 md:mt-0">
            {pages.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                {q ? `No pages match "${q}".` : (
                  <>
                    No wiki pages yet.{" "}
                    <Link href="/wiki/new" className="text-brand-600 underline">
                      Write the first one
                    </Link>
                    .
                  </>
                )}
              </p>
            ) : (
              <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
                {pages.map((p) => (
                  <li key={p.id}>
                    <Link
                      href={`/wiki/${p.id}`}
                      className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
                    >
                      <span className="flex-1 truncate text-sm font-medium">{p.title}</span>
                      {p.visibility === "group" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                          <FileLock className="h-3 w-3" aria-hidden /> restricted
                        </span>
                      ) : null}
                      <span className="hidden w-40 text-right text-xs text-slate-500 dark:text-slate-400 sm:inline">
                        <LocalDateTime value={p.updatedAt} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
