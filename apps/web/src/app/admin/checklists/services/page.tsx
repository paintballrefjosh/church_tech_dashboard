import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, ArrowLeft, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { WEEKDAYS } from "@church/shared";

interface ServiceRow {
  id: string;
  name: string;
  active: boolean;
  recurrenceKind: string;
  weekday: number;
  timeOfDay: string;
}

export const dynamic = "force-dynamic";

export default async function ChecklistServicesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const services = await apiJson<ServiceRow[]>("/api/v1/checklists/services").catch(
    () => [] as ServiceRow[],
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-10">
        <nav className="mb-3 text-sm">
          <Link href="/admin/checklists" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Checklists admin
          </Link>
        </nav>
        <header className="flex flex-wrap items-center gap-3">
          <PageTitle icon={CalendarClock}>Services</PageTitle>
          <Link
            href="/admin/checklists/services/new"
            className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
          >
            <Plus className="h-4 w-4" aria-hidden /> New service
          </Link>
        </header>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Recurring services generate their events automatically, each seeded with the stations and
          default people you set here. Works with or without Planning Center.
        </p>

        {services.length === 0 ? (
          <p className="mt-6 rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
            No services yet. Create one to schedule recurring checklists.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
            {services.map((s) => (
              <li key={s.id}>
                <Link href={`/admin/checklists/services/${s.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900">
                  <CalendarClock className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-slate-500">
                      {s.recurrenceKind === "weekly" ? `Every ${WEEKDAYS[s.weekday]} at ${s.timeOfDay}` : "No schedule"}
                    </div>
                  </div>
                  {!s.active ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] uppercase text-slate-500 dark:bg-slate-800">
                      Paused
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
