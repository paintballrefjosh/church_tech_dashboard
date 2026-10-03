import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays, Settings as SettingsIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";

interface PcPlan {
  id: string;
  title: string;
  sortDate: string | null;
  seriesTitle: string | null;
  serviceTypeId: string;
  serviceTypeName: string | null;
}

export const dynamic = "force-dynamic";

export default async function PlanningCenterPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  // Health-check first so we can show a friendly "configure me" state instead
  // of an error when the operator hasn't filled in credentials yet.
  let health: { configured: boolean; reachable: boolean; error: string | null } = {
    configured: false,
    reachable: false,
    error: null,
  };
  try {
    health = await apiJson("/api/v1/planning-center/health");
  } catch {
    /* leave health.reachable = false */
  }

  let plans: PcPlan[] = [];
  if (health.configured && health.reachable) {
    plans = await apiJson<PcPlan[]>("/api/v1/planning-center/plans?limit=25").catch(() => []);
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={CalendarDays}>Planning Center</PageTitle>
          <Link
            href="/admin/settings/planning_center"
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden /> Config
          </Link>
        </header>

        {!health.configured ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            Planning Center isn&apos;t configured. Set{" "}
            <code className="mx-0.5">planning_center.app_id</code>,{" "}
            <code className="mx-0.5">planning_center.secret</code> and{" "}
            <code className="mx-0.5">planning_center.default_service_type_id</code> in{" "}
            <Link href="/admin/settings/planning_center" className="underline">
              Settings
            </Link>{" "}
            to enable.
          </p>
        ) : !health.reachable ? (
          <p className="rounded-md border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Planning Center unreachable: {health.error ?? "unknown error"}.
          </p>
        ) : plans.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
            No upcoming services in the default service type. Pick a different service type
            id in{" "}
            <Link href="/admin/settings/planning_center" className="underline">
              Settings
            </Link>{" "}
            if needed.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
            {plans.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/planning-center/${p.serviceTypeId}/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium">{p.title}</div>
                    {p.seriesTitle ? (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {p.seriesTitle}
                      </div>
                    ) : null}
                  </div>
                  {p.sortDate ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      <LocalDateTime
                        value={p.sortDate}
                        options={{
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }}
                      />
                    </span>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
