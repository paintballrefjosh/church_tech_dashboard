import Link from "next/link";
import { redirect } from "next/navigation";
import { ListChecks, FileText, Calendar, BarChart3, CalendarClock, MonitorSpeaker } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";
import type { ChecklistTemplate, ChecklistEvent } from "@church/shared";

/** listTemplates() also returns a task count per template (see checklists.service.ts). */
type TemplateWithCount = ChecklistTemplate & { taskCount: number };

export const dynamic = "force-dynamic";

export default async function AdminChecklistsHomePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [templates, events, services] = await Promise.all([
    apiJson<TemplateWithCount[]>("/api/v1/checklists/templates").catch(
      () => [] as TemplateWithCount[],
    ),
    apiJson<ChecklistEvent[]>("/api/v1/checklists/events").catch(() => [] as ChecklistEvent[]),
    apiJson<{ id: string }[]>("/api/v1/checklists/services").catch(() => [] as { id: string }[]),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <header className="flex flex-wrap items-center gap-3">
          <PageTitle icon={ListChecks}>Checklists admin</PageTitle>
          <Link
            href="/admin/checklists/stations"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <MonitorSpeaker className="h-4 w-4" aria-hidden /> Stations
          </Link>
          <Link
            href="/admin/checklists/reports"
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <BarChart3 className="h-4 w-4" aria-hidden /> Reports
          </Link>
        </header>

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-slate-500" aria-hidden /> Templates ({templates.length})
            </h2>
            <Link
              href="/admin/checklists/templates/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              New template
            </Link>
          </div>
          {templates.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              Templates are reusable task lists. Create one (e.g. &ldquo;Sunday Sound Setup&rdquo;)
              then instantiate it as an event for each Sunday.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {templates.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/admin/checklists/templates/${t.id}`}
                    className="flex items-center gap-2 py-2 hover:underline"
                  >
                    <span className="font-medium">{t.name}</span>
                    {t.description ? (
                      <span className="truncate text-xs text-slate-500">— {t.description}</span>
                    ) : null}
                    <span className="ml-auto shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      {t.taskCount} {t.taskCount === 1 ? "item" : "items"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="h-4 w-4 text-slate-500" aria-hidden /> Services ({services.length})
            </h2>
            <Link
              href="/admin/checklists/services"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              Manage services
            </Link>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            A service is a recurring schedule (e.g. every Sunday) that auto-generates events with
            their stations and default people set up front. Put shared station-tablet accounts in a
            group with the Checklists <span className="font-medium">moderator</span> tier so they can
            work any station&apos;s list.
          </p>
        </section>

        <section className="mt-6 rounded-md border border-slate-300 p-4 dark:border-slate-800">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium">
              <Calendar className="h-4 w-4 text-slate-500" aria-hidden /> Events ({events.length})
            </h2>
            <Link
              href="/admin/checklists/events/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
            >
              New event
            </Link>
          </div>
          {events.length === 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              An event is one instance of a template tied to a specific date. Volunteers tick boxes
              on event-tasks, not template-tasks.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-200 text-sm dark:divide-slate-800">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/checklists/${e.id}`}
                      className="font-medium hover:underline"
                    >
                      {e.name}
                    </Link>
                    {e.scheduledAt ? (
                      <span className="ml-2 text-xs text-slate-500">
                        <LocalDateTime
                          value={e.scheduledAt}
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
