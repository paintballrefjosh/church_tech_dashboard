import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Server } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { InfraTarget } from "@church/shared";
import { InfraTargetForm } from "../../infra-target-form";

export const dynamic = "force-dynamic";

export default async function EditInfraTargetPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  const target = await apiJson<InfraTarget>(`/api/v1/infra/targets/${id}`).catch(() => null);
  if (!target) notFound();

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link
          href={`/monitoring/infra/${id}`}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back
        </Link>
        <PageTitle icon={Server}>Edit {target.name}</PageTitle>
        <InfraTargetForm initial={target} />
      </main>
    </>
  );
}
