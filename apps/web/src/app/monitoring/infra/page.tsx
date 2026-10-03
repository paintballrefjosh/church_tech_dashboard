import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { InfraTarget, InfraSummary } from "@church/shared";
import { InfraOverviewClient } from "./infra-overview-client";
import { MonitoringTabs } from "../section-tabs";

export const dynamic = "force-dynamic";

export default async function InfraPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [targets, summary] = await Promise.all([
    apiJson<InfraTarget[]>("/api/v1/infra/targets").catch(() => [] as InfraTarget[]),
    apiJson<InfraSummary>("/api/v1/infra/summary").catch(() => null),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Agentless resource monitoring for Linux hosts (SSH), Docker hosts, and Proxmox VE —
            CPU, memory, disk, network, containers and VMs, with threshold alerts.
          </p>
          <div className="ml-auto">
            <Link
              href="/monitoring/infra/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> Add target
            </Link>
          </div>
        </header>
        <InfraOverviewClient initialTargets={targets} initialSummary={summary} />
      </main>
    </>
  );
}
