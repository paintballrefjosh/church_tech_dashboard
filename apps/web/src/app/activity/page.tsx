import Link from "next/link";
import { redirect } from "next/navigation";
import { Rss, LifeBuoy, BookOpen, StickyNote, Activity as ActivityIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";

interface ActivityEvent {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  title: string;
  summary: string | null;
  link: string | null;
  ts: string;
}

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { Icon: typeof LifeBuoy; pill: string; bar: string }> = {
  ticket: {
    Icon: LifeBuoy,
    pill: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200",
    bar: "border-sky-500",
  },
  wiki_page: {
    Icon: BookOpen,
    pill: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
    bar: "border-amber-500",
  },
  note: {
    Icon: StickyNote,
    pill: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
    bar: "border-emerald-500",
  },
  monitor: {
    Icon: ActivityIcon,
    pill: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200",
    bar: "border-rose-500",
  },
};

export default async function ActivityPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const items = await apiJson<ActivityEvent[]>("/api/v1/activity?limit=100").catch(
    () => [] as ActivityEvent[],
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Rss}>Activity</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          A timeline of the most recent things happening across the site.
        </p>

        {items.length === 0 ? (
          <p className="mt-6 rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
            No activity yet. As people create tickets, edit pages and pin notes, you&apos;ll see them here.
          </p>
        ) : (
          <ol className="mt-6 space-y-2">
            {items.map((e) => {
              const meta = KIND_META[e.resourceType] ?? {
                Icon: Rss,
                pill: "bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200",
                bar: "border-slate-400",
              };
              return (
                <li
                  key={e.id}
                  className={`relative rounded-md border border-slate-300 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900 ${meta.bar} border-l-4`}
                >
                  <div className="flex items-start gap-3">
                    <meta.Icon className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span
                          className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${meta.pill}`}
                        >
                          {e.action}
                        </span>
                        {e.link ? (
                          <Link href={e.link} className="truncate font-medium hover:underline">
                            {e.title}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">{e.title}</span>
                        )}
                      </div>
                      {e.summary ? (
                        <p className="mt-0.5 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                          {e.summary}
                        </p>
                      ) : null}
                      <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                        {e.actorEmail ?? "system"} · <LocalDateTime value={e.ts} />
                      </p>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </main>
    </>
  );
}
