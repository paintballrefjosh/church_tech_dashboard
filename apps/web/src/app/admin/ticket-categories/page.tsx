import { redirect } from "next/navigation";
import { Tags } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { TicketCategory } from "@church/shared";
import { CategoriesAdminClient } from "./categories-admin-client";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions: string[];
}

export default async function AdminTicketCategoriesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const canWrite = me?.permissions?.includes("tickets:categories:admin") ?? false;

  const categories = await apiJson<TicketCategory[]>("/api/v1/ticket-categories").catch(
    () => [] as TicketCategory[],
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={Tags}>Ticket categories</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Admin-curated multi-select for tickets. Anyone with ticket access can pick from this
          list; only users with <code className="font-mono">tickets:categories:admin</code> can
          add, rename, recolour, or delete entries.
        </p>
        <CategoriesAdminClient initial={categories} canWrite={canWrite} />
      </main>
    </>
  );
}
