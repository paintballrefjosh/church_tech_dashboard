import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Activity, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { Monitor, MonitorCheck, MonitorIncident } from "@church/shared";
import { MonitorDetailClient } from "./monitor-detail-client";

export const dynamic = "force-dynamic";

export default async function MonitorDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;

  const res = await apiFetch(`/api/v1/monitors/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  const monitor = (await res.json()) as Monitor;
  // 240 checks ≈ 4 hours at the default 60s interval. Was 120 (~2 h), which
  // let a brief failure scroll off the sparkline before an operator opened
  // the page in response to the notification.
  const history = await apiJson<MonitorCheck[]>(
    `/api/v1/monitors/${encodeURIComponent(id)}/history?limit=240`,
  ).catch(() => [] as MonitorCheck[]);
  const incidents = await apiJson<MonitorIncident[]>(
    `/api/v1/monitors/${encodeURIComponent(id)}/incidents`,
  ).catch(() => [] as MonitorIncident[]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href="/monitoring"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to monitors
          </Link>
        </nav>
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={Activity}>{monitor.name}</PageTitle>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Link
              href={`/monitoring/${monitor.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <Pencil className="h-4 w-4" aria-hidden /> Edit
            </Link>
          </div>
        </header>

        <MonitorDetailClient
          initialMonitor={monitor}
          initialHistory={history}
          initialIncidents={incidents}
        />
      </main>
    </>
  );
}
