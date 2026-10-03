import Link from "next/link";
import { redirect } from "next/navigation";
import { BarChart3, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";

interface EventStat {
  eventId: string;
  eventName: string;
  scheduledAt: string | null;
  total: number;
  completed: number;
  assigned: number;
  pctComplete: number;
}
interface VolunteerStat {
  userId: string;
  email: string;
  name: string | null;
  assigned: number;
  completed: number;
  pctComplete: number;
}

export const dynamic = "force-dynamic";

export default async function ChecklistReportsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [events, volunteers] = await Promise.all([
    apiJson<EventStat[]>("/api/v1/checklists/reports/events?limit=50").catch(
      () => [] as EventStat[],
    ),
    apiJson<VolunteerStat[]>("/api/v1/checklists/reports/volunteers?limit=100").catch(
      () => [] as VolunteerStat[],
    ),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href="/admin/checklists"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to checklists admin
          </Link>
        </nav>
        <PageTitle icon={BarChart3}>Checklist reports</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Recent completion stats — by event and by volunteer.
        </p>

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <h2 className="text-sm font-medium">By event ({events.length})</h2>
          {events.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">No events yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1.5 pr-3">Event</th>
                    <th className="py-1.5 pr-3">When</th>
                    <th className="py-1.5 pr-3 text-right">Tasks</th>
                    <th className="py-1.5 pr-3 text-right">Done</th>
                    <th className="py-1.5">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {events.map((e) => (
                    <tr key={e.eventId}>
                      <td className="py-2 pr-3">
                        <Link href={`/checklists/${e.eventId}`} className="hover:underline">
                          {e.eventName}
                        </Link>
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500">
                        {e.scheduledAt ? (
                          <LocalDateTime value={e.scheduledAt} options={{ month: "short", day: "numeric" }} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">{e.total}</td>
                      <td className="py-2 pr-3 text-right">{e.completed}</td>
                      <td className="py-2">
                        <ProgressBar pct={e.pctComplete} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <h2 className="text-sm font-medium">By volunteer ({volunteers.length})</h2>
          {volunteers.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">No volunteer assignments yet.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1.5 pr-3">Volunteer</th>
                    <th className="py-1.5 pr-3 text-right">Assigned</th>
                    <th className="py-1.5 pr-3 text-right">Completed</th>
                    <th className="py-1.5">Progress</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {volunteers.map((v) => (
                    <tr key={v.userId}>
                      <td className="py-2 pr-3">
                        <span className="font-medium">{v.name ?? v.email}</span>
                        {v.name ? (
                          <span className="ml-1 text-xs text-slate-500">{v.email}</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right">{v.assigned}</td>
                      <td className="py-2 pr-3 text-right">{v.completed}</td>
                      <td className="py-2">
                        <ProgressBar pct={v.pctComplete} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-32 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className={`h-full ${pct === 100 ? "bg-emerald-500" : "bg-brand-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-slate-500">{pct}%</span>
    </div>
  );
}
