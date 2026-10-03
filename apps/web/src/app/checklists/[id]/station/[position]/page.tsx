import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ListChecks, ArrowLeft, CalendarClock } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { ChecklistEvent, ChecklistEventTask, EventAssignee } from "@church/shared";
import { StationClient } from "./station-client";

interface MePayload {
  id: string;
  permissions: string[];
}

export const dynamic = "force-dynamic";

/** Station key normalizer — mirrors the server's posKey (null → "Other"). */
function posKeyOf(positionName: string | null): string {
  return positionName && positionName.trim() ? positionName : "Other";
}

export default async function StationPage({
  params,
}: {
  params: Promise<{ id: string; position: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id, position: rawPosition } = await params;
  const position = decodeURIComponent(rawPosition);

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const myId = me?.id ?? "";
  const isAdmin = me?.permissions.includes("checklists:admin") ?? false;
  const canCompleteAny = isAdmin || (me?.permissions.includes("checklists:complete:any") ?? false);

  const res = await apiFetch(`/api/v1/checklists/events/${encodeURIComponent(id)}`);
  if (res.status === 404 || res.status === 403) notFound();
  const detail = (await res.json()) as {
    event: ChecklistEvent;
    tasks: ChecklistEventTask[];
    roster: EventAssignee[];
  };

  const stationTasks = detail.tasks.filter((t) => posKeyOf(t.positionName) === position);
  if (stationTasks.length === 0) notFound();

  const rostered = detail.roster.some((a) => a.positionName === position && a.userId === myId);
  const canComplete = isAdmin || canCompleteAny || rostered;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-2xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href={`/checklists/${id}`}
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Full checklist
          </Link>
        </nav>
        <PageTitle icon={ListChecks}>{position}</PageTitle>
        <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {detail.event.name}
        </p>

        <StationClient
          eventId={detail.event.id}
          initialTasks={stationTasks}
          canComplete={canComplete}
          myUserId={myId}
        />
      </main>
    </>
  );
}
