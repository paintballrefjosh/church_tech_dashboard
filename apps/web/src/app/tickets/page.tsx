import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { StatusBadge, PriorityBadge } from "./ticket-badges";
import type { Ticket, TicketStatus, TicketPriority } from "@church/shared";

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
  }>("/api/v1/me").catch(() => null);
  const canSeeAll = me?.permissions.includes("tickets:read:any") ?? false;
  const scope = params.scope === "all" && canSeeAll ? "all" : "own";

  const qs = new URLSearchParams();
  qs.set("scope", scope);
  if (params.status && (STATUSES as string[]).includes(params.status)) qs.set("status", params.status);
  if (params.priority && (PRIORITIES as string[]).includes(params.priority))
    qs.set("priority", params.priority);
  if (params.assigned === "me" || params.assigned === "unassigned") qs.set("assigned", params.assigned);
  if (params.q) qs.set("q", params.q);

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
          <h1 className="text-2xl font-semibold">Tickets</h1>
          <div className="ml-auto flex items-center gap-2">
            <Link
              href="/tickets/new"
              className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              + New ticket
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

        {tickets.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No tickets match these filters.{" "}
            <Link href="/tickets/new" className="text-brand-600 underline">
              Open a new one
            </Link>
            .
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {tickets.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/tickets/${t.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
                >
                  <span className="w-12 font-mono text-xs text-slate-500 dark:text-slate-400">
                    #{t.number}
                  </span>
                  <span className="flex-1 truncate text-sm font-medium">{t.title}</span>
                  <PriorityBadge priority={t.priority} />
                  <StatusBadge status={t.status} />
                  <span className="hidden w-32 text-right text-xs text-slate-500 dark:text-slate-400 sm:inline">
                    {new Date(t.updatedAt).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
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
