import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { ListChecks, ArrowLeft, CalendarClock } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LocalDateTime } from "@/components/local-date-time";
import type {
  AssignableUser,
  ChecklistEvent,
  ChecklistEventTask,
  EventAssignee,
} from "@church/shared";
import { EventTasksClient } from "./event-tasks-client";

interface MePayload {
  id: string;
  permissions: string[];
}

export const dynamic = "force-dynamic";

export default async function ChecklistEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;

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

  // Only admins can (re)assign, so only they need the user list for the picker.
  const assignableUsers = isAdmin
    ? await apiJson<AssignableUser[]>("/api/v1/checklists/assignable-users").catch(
        () => [] as AssignableUser[],
      )
    : [];

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href="/checklists"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to checklists
          </Link>
        </nav>
        <PageTitle icon={ListChecks}>{detail.event.name}</PageTitle>
        {detail.event.scheduledAt ? (
          <p className="mt-1 inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
            <CalendarClock className="h-3.5 w-3.5" aria-hidden />
            <LocalDateTime
              value={detail.event.scheduledAt}
              options={{
                weekday: "long",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }}
            />
          </p>
        ) : null}

        <EventTasksClient
          eventId={detail.event.id}
          initialTasks={detail.tasks}
          initialRoster={detail.roster}
          myUserId={myId}
          isAdmin={isAdmin}
          canCompleteAny={canCompleteAny}
          assignableUsers={assignableUsers}
          hasPcPlan={!!detail.event.pcPlanId && !!detail.event.pcServiceTypeId}
        />
      </main>
    </>
  );
}
