import { redirect } from "next/navigation";
import { Tags } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { ModuleSettingsPage } from "@/components/module-settings";
import { TICKETS_SETTINGS_NAV } from "../settings/nav";
import type { TicketCategory } from "@lampstand/shared";
import { CategoriesAdminClient } from "./categories-admin-client";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions: string[];
}

export default async function TicketCategoriesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const canWrite = me?.permissions?.includes("tickets:categories:admin") ?? false;

  const categories = await apiJson<TicketCategory[]>("/api/v1/ticket-categories").catch(
    () => [] as TicketCategory[],
  );

  return (
    <ModuleSettingsPage chrome back={{ href: "/tickets", label: "tickets" }} title="Ticket categories" icon={Tags} nav={TICKETS_SETTINGS_NAV}>
      <p className="text-sm text-slate-600 dark:text-slate-400">
        The list staff pick from when they sort a ticket. Anyone with ticket access can pick from it; only a Tickets admin can add, rename, recolour or delete entries.
      </p>
      <CategoriesAdminClient initial={categories} canWrite={canWrite} />
    </ModuleSettingsPage>
  );
}
