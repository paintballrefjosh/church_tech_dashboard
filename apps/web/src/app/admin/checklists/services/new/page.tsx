import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarClock, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { AssignableUser, ChecklistTemplate } from "@church/shared";
import { ServiceEditor } from "../service-editor";

export const dynamic = "force-dynamic";

export default async function NewServicePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

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
        <PageTitle icon={CalendarClock}>New service</PageTitle>
        <ServiceEditor templates={templates.map((t) => ({ id: t.id, name: t.name }))} users={users} />
      </main>
    </>
  );
}
