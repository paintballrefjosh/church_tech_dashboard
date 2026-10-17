import { redirect } from "next/navigation";
import Link from "next/link";
import { ClipboardCheck } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";
import { describeWikiAge } from "@church/shared";

export const dynamic = "force-dynamic";

interface ReviewItem {
  id: string;
  title: string;
  ownerUserId: string;
  owner: string | null;
  confirmedAt: string;
  dueAt: string;
  daysOverdue: number;
  intervalDays: number;
}

export default async function WikiReviewPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) redirect("/change-password");

  const { scope: raw } = await searchParams;
  const scope = raw === "mine" ? "mine" : "all";
  const data = await apiJson<{ total: number; items: ReviewItem[] }>(`/api/v1/wiki/review?scope=${scope}`).catch(() => null);

  const pill = (active: boolean) =>
    `rounded-md border px-2 py-0.5 text-xs ${
      active
        ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
        : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    }`;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <nav className="mb-4 text-sm">
          <Link href="/wiki" className="text-brand-600 hover:underline">
            ← Wiki
          </Link>
        </nav>
        <PageTitle icon={ClipboardCheck}>Pages to review</PageTitle>
        <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Pages nobody has edited or confirmed for a while, longest first. Open one, fix what has changed, and choose
          &ldquo;This page is still correct&rdquo; if it is.
        </p>
        <div className="mt-4 flex items-center gap-2 text-sm">
          <Link href="/wiki/review" className={pill(scope === "all")}>
            All pages
          </Link>
          <Link href="/wiki/review?scope=mine" className={pill(scope === "mine")}>
            Mine
          </Link>
          {data ? (
            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400" data-testid="review-total">
              {data.total} {data.total === 1 ? "page" : "pages"}
            </span>
          ) : null}
        </div>

        {!data ? (
          <p className="mt-6 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Could not load the list.
          </p>
        ) : data.items.length === 0 ? (
          <p className="mt-6 rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            Nothing is due. Every page has been edited or confirmed recently.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800" data-testid="review-list">
            {data.items.map((p) => (
              <li key={p.id}>
                <Link href={`/wiki/${p.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.title}</span>
                  <span className="text-xs text-slate-500 dark:text-slate-400">{p.owner ?? "No owner"}</span>
                  <span className="text-xs text-amber-700 dark:text-amber-300">
                    last checked <LocalDateTime value={p.confirmedAt} options={{ dateStyle: "medium" }} /> ({describeWikiAge(p.daysOverdue + p.intervalDays)} ago)
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
