import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import type { WikiPage } from "@church/shared";
import { WikiSearch } from "./wiki-search";

export const dynamic = "force-dynamic";

export default async function WikiListPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const url = `/api/v1/wiki${q ? `?q=${encodeURIComponent(q)}` : ""}`;
  const pages = await apiJson<WikiPage[]>(url).catch(() => [] as WikiPage[]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Wiki</h1>
          <div className="ml-auto flex items-center gap-2">
            <WikiSearch defaultValue={q} />
            <Link
              href="/wiki/new"
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              + New page
            </Link>
          </div>
        </header>

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
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {pages.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/wiki/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <span className="flex-1 truncate text-sm font-medium">{p.title}</span>
                  {p.visibility === "group" ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                      restricted
                    </span>
                  ) : null}
                  <span className="hidden w-40 text-right text-xs text-slate-500 dark:text-slate-400 sm:inline">
                    {new Date(p.updatedAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
