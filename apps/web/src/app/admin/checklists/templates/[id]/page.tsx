import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { FileText, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { ChecklistStation, ChecklistTemplate, ChecklistTemplateTask } from "@church/shared";
import { TemplateEditorClient } from "./template-editor-client";

export const dynamic = "force-dynamic";

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  const res = await apiFetch(`/api/v1/checklists/templates/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  const detail = (await res.json()) as {
    template: ChecklistTemplate;
    tasks: ChecklistTemplateTask[];
  };
  const stations = await apiJson<ChecklistStation[]>("/api/v1/checklists/stations").catch(
    () => [] as ChecklistStation[],
  );

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
        <PageTitle icon={FileText}>{detail.template.name}</PageTitle>
        {detail.template.description ? (
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            {detail.template.description}
          </p>
        ) : null}
        <TemplateEditorClient template={detail.template} initialTasks={detail.tasks} stations={stations} />
      </main>
    </>
  );
}
