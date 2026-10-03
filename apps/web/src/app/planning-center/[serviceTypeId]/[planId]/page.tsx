import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { CalendarDays, ArrowLeft, Clock, CircleCheck, CircleHelp, AlertTriangle } from "lucide-react";
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
interface PcTime {
  id: string;
  startsAt: string | null;
  endsAt: string | null;
  description: string | null;
}
interface PcAssignment {
  positionName: string;
  teamMemberId: string;
  pcPersonId: string | null;
  pcPersonName: string;
  status: string | null;
  localUserId: string | null;
}

export const dynamic = "force-dynamic";

export default async function PlanDetailPage({
  params,
}: {
  params: Promise<{ serviceTypeId: string; planId: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { serviceTypeId, planId } = await params;

  const detail = await apiJson<{ plan: PcPlan | null; times: PcTime[]; assignments: PcAssignment[] }>(
    `/api/v1/planning-center/plans/${encodeURIComponent(serviceTypeId)}/${encodeURIComponent(planId)}`,
  ).catch(() => null);
  if (!detail || !detail.plan) notFound();

  const { plan, times, assignments } = detail;
  // Group assignments by position. Same position with multiple people
  // becomes one row with a comma-separated list.
  const byPosition = new Map<string, PcAssignment[]>();
  for (const a of assignments) {
    const list = byPosition.get(a.positionName) ?? [];
    list.push(a);
    byPosition.set(a.positionName, list);
  }
  const positions = [...byPosition.keys()].sort();

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href="/planning-center"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to services
          </Link>
        </nav>
        <PageTitle icon={CalendarDays}>{plan.title}</PageTitle>
        {plan.seriesTitle ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{plan.seriesTitle}</p>
        ) : null}

        {times.length > 0 ? (
          <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Times</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {times.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 text-slate-400" aria-hidden />
                  <span>
                    {t.startsAt ? (
                      <LocalDateTime
                        value={t.startsAt}
                        options={{
                          weekday: "long",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                        }}
                      />
                    ) : (
                      "—"
                    )}
                  </span>
                  {t.description ? (
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      · {t.description}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Positions
          </h2>
          {positions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No team members assigned yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {positions.map((p) => (
                <li key={p} className="flex items-baseline gap-3 py-2">
                  <span className="w-36 shrink-0 text-xs uppercase tracking-wide text-slate-500">
                    {p}
                  </span>
                  <div className="flex-1">
                    {byPosition.get(p)!.map((a, i) => (
                      <span key={a.teamMemberId} className="mr-2 inline-flex items-center gap-1">
                        {i > 0 ? <span className="text-slate-400">·</span> : null}
                        <StatusIcon status={a.status} />
                        <span
                          className={
                            a.localUserId
                              ? "font-medium text-brand-700 dark:text-brand-300"
                              : "text-slate-700 dark:text-slate-200"
                          }
                          title={a.localUserId ? "Linked to a local user" : undefined}
                        >
                          {a.pcPersonName}
                        </span>
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

function StatusIcon({ status }: { status: string | null }) {
  if (status === "C")
    return <CircleCheck className="h-3.5 w-3.5 text-emerald-500" aria-label="Confirmed" />;
  if (status === "D")
    return <AlertTriangle className="h-3.5 w-3.5 text-rose-500" aria-label="Declined" />;
  return <CircleHelp className="h-3.5 w-3.5 text-slate-400" aria-label="Unconfirmed" />;
}
