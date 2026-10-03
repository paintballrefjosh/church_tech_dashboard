import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import type { InfraTarget, InfraEntity, MonitorIncident, InfraUpdateRun } from "@church/shared";
import { InfraDetailClient } from "./infra-detail-client";

export const dynamic = "force-dynamic";

export default async function InfraDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;

  const target = await apiJson<InfraTarget>(`/api/v1/infra/targets/${id}`).catch(() => null);
  if (!target) notFound();
  const [entities, incidents, updateRuns] = await Promise.all([
    apiJson<InfraEntity[]>(`/api/v1/infra/targets/${id}/entities`).catch(() => [] as InfraEntity[]),
    apiJson<MonitorIncident[]>(`/api/v1/infra/targets/${id}/incidents`).catch(() => [] as MonitorIncident[]),
    apiJson<InfraUpdateRun[]>(`/api/v1/infra/targets/${id}/update-runs`).catch(() => [] as InfraUpdateRun[]),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link
          href="/monitoring/infra"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Infrastructure
        </Link>
        <InfraDetailClient
          initialTarget={target}
          initialEntities={entities}
          initialIncidents={incidents}
          initialUpdateRuns={updateRuns}
        />
      </main>
    </>
  );
}
