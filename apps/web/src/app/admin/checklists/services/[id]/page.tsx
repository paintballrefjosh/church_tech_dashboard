import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { CalendarClock, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { AssignableUser, ChecklistService, ChecklistTemplate } from "@church/shared";
import { ServiceEditor } from "../service-editor";

export const dynamic = "force-dynamic";

export default async function EditServicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;

  const res = await apiFetch(`/api/v1/checklists/services/${encodeURIComponent(id)}`);
  if (res.status === 404 || res.status === 403) notFound();
  const service = (await res.json()) as ChecklistService;

  const [templates, users] = await Promise.all([
    apiJson<ChecklistTemplate[]>("/api/v1/checklists/templates").catch(() => [] as ChecklistTemplate[]),
    apiJson<AssignableUser[]>("/api/v1/checklists/assignable-users").catch(() => [] as AssignableUser[]),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <nav className="mb-3 text-sm">
          <Link href="/admin/checklists/services" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Services
          </Link>
        </nav>
        <PageTitle icon={CalendarClock}>{service.name}</PageTitle>
        <ServiceEditor
          templates={templates.map((t) => ({ id: t.id, name: t.name }))}
          users={users}
          initial={service}
        />
      </main>
    </>
  );
}
