import Link from "next/link";
import { redirect } from "next/navigation";
import { Calendar, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { ChecklistTemplate } from "@church/shared";
import { NewEventForm } from "./new-event-form";

interface PcPlan {
  id: string;
  title: string;
  sortDate: string | null;
  serviceTypeId: string;
}
interface PcHealth {
  configured: boolean;
  reachable: boolean;
}

export const dynamic = "force-dynamic";

export default async function NewChecklistEventPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [templates, pcHealth, pcPlans] = await Promise.all([
    apiJson<ChecklistTemplate[]>("/api/v1/checklists/templates").catch(
      () => [] as ChecklistTemplate[],
    ),
    apiJson<PcHealth>("/api/v1/planning-center/health").catch(
      () => ({ configured: false, reachable: false }) as PcHealth,
    ),
    apiJson<PcPlan[]>("/api/v1/planning-center/plans?limit=25").catch(() => [] as PcPlan[]),
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
        <PageTitle icon={Calendar}>New event</PageTitle>

        {templates.length === 0 ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            You need a template first.{" "}
            <Link href="/admin/checklists/templates/new" className="underline">
              Create one
            </Link>
            , then come back to instantiate it as an event.
          </p>
        ) : (
          <NewEventForm
            templates={templates}
            pcConfigured={pcHealth.configured && pcHealth.reachable}
            pcPlans={pcPlans}
          />
        )}
      </main>
    </>
  );
}
