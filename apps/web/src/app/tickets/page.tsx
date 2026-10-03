import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LifeBuoy, Plus } from "lucide-react";
import { StatusBadge, PriorityBadge } from "./ticket-badges";
import { TicketsTagFilter } from "./tag-filter-island";
import { TicketsListClient } from "./tickets-list-client";
import { SavedViewsBar } from "./saved-views-bar";
import type {
  Ticket,
  TicketSlaMap,
  TicketStatus,
  TicketPriority,
} from "@church/shared";

export const dynamic = "force-dynamic";

const STATUSES: TicketStatus[] = ["open", "in_progress", "resolved", "closed"];
const PRIORITIES: TicketPriority[] = ["low", "normal", "high", "urgent"];

export default async function TicketsListPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    priority?: string;
    assigned?: string;
    scope?: string;
    q?: string;
    tag?: string;
  }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }

  const params = await searchParams;
  const me = await apiJson<{
    id: string;
    email: string;
    permissions: string[];
    slaTargets?: TicketSlaMap;
  }>("/api/v1/me").catch(() => null);
  const canSeeAll = me?.permissions.includes("tickets:read:any") ?? false;
  const canAdmin = me?.permissions.includes("tickets:admin") ?? false;
  const slaTargets: TicketSlaMap = me?.slaTargets ?? {
    low: { responseMin: 0, resolutionMin: 0 },
    normal: { responseMin: 0, resolutionMin: 0 },
    high: { responseMin: 0, resolutionMin: 0 },
    urgent: { responseMin: 0, resolutionMin: 0 },
  };
  const scope = params.scope === "all" && canSeeAll ? "all" : "own";

  const qs = new URLSearchParams();
  qs.set("scope", scope);
  if (params.status && (STATUSES as string[]).includes(params.status)) qs.set("status", params.status);
  if (params.priority && (PRIORITIES as string[]).includes(params.priority))
    qs.set("priority", params.priority);
  if (params.assigned === "me" || params.assigned === "unassigned") qs.set("assigned", params.assigned);
  if (params.q) qs.set("q", params.q);
  if (params.tag) qs.set("tagId", params.tag);

  const tickets = await apiJson<Ticket[]>(`/api/v1/tickets?${qs}`).catch(() => [] as Ticket[]);

  function link(overrides: Record<string, string | null>) {
    const sp = new URLSearchParams(qs);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    const str = sp.toString();
    return str ? `/tickets?${str}` : "/tickets";
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={LifeBuoy}>Tickets</PageTitle>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/tickets/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> New ticket
            </Link>
          </div>
        </header>

        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <FilterGroup label="Scope">
            {canSeeAll ? (
              <>
                <FilterPill href={link({ scope: "own" })} active={scope === "own"}>
                  My tickets
                </FilterPill>
                <FilterPill href={link({ scope: "all" })} active={scope === "all"}>
                  All
                </FilterPill>
              </>
            ) : (
              <span className="text-xs text-slate-500 dark:text-slate-400">My tickets</span>
            )}
          </FilterGroup>

          <FilterGroup label="Status">
            <FilterPill href={link({ status: null })} active={!params.status}>
              Any
            </FilterPill>
            {STATUSES.map((s) => (
              <FilterPill key={s} href={link({ status: s })} active={params.status === s}>
                <StatusBadge status={s} />
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Priority">
            <FilterPill href={link({ priority: null })} active={!params.priority}>
              Any
            </FilterPill>
            {PRIORITIES.map((p) => (
              <FilterPill key={p} href={link({ priority: p })} active={params.priority === p}>
                <PriorityBadge priority={p} />
              </FilterPill>
            ))}
          </FilterGroup>

          {canSeeAll ? (
            <FilterGroup label="Assigned">
              <FilterPill href={link({ assigned: null })} active={!params.assigned}>
                Any
              </FilterPill>
              <FilterPill href={link({ assigned: "me" })} active={params.assigned === "me"}>
                Me
              </FilterPill>
              <FilterPill
                href={link({ assigned: "unassigned" })}
                active={params.assigned === "unassigned"}
              >
                Unassigned
              </FilterPill>
            </FilterGroup>
          ) : null}
        </div>

        <TicketsTagFilter />

        <div className="mb-4">
          <SavedViewsBar resourceType="ticket" />
        </div>

        <TicketsListClient
          tickets={tickets}
          slaTargets={slaTargets}
          canAdmin={canAdmin}
        />
      </main>
    </>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</span>
      {children}
    </div>
  );
}

function FilterPill({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-md border px-2 py-0.5 text-xs ${
        active
          ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
          : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      }`}
    >
      {children}
    </Link>
  );
}
