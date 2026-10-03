import Link from "next/link";
import { redirect } from "next/navigation";
import { ListChecks, Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ChecklistsBrowser } from "./checklists-browser";
import type { ChecklistEvent } from "@church/shared";

export const dynamic = "force-dynamic";

export default async function ChecklistsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const events = await apiJson<ChecklistEvent[]>("/api/v1/checklists/events").catch(
    () => [] as ChecklistEvent[],
  );

  const me = await apiJson<{ permissions: string[] }>("/api/v1/me").catch(() => null);
  const canManage = me?.permissions.includes("checklists:read:any") ?? false;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex items-center justify-between gap-3">
          <PageTitle icon={ListChecks}>Checklists</PageTitle>
          {canManage ? (
            <Link
              href="/admin/checklists"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Settings className="h-4 w-4" aria-hidden /> Checklist admin
            </Link>
          ) : null}
        </div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Events with checklists you&apos;re part of, past and upcoming. Click in to tick off your tasks.
        </p>

        <ChecklistsBrowser events={events} />
      </main>
    </>
  );
}
