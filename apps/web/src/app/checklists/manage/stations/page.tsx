import Link from "next/link";
import { redirect } from "next/navigation";
import { MonitorSpeaker, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { SettingsNav } from "@/components/settings-nav";
import { CHECKLISTS_MANAGE_NAV } from "../nav";

import type { ChecklistStation } from "@lampstand/shared";
import { StationsAdminClient } from "./stations-admin-client";

export const dynamic = "force-dynamic";

export default async function ChecklistStationsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const stations = await apiJson<ChecklistStation[]>("/api/v1/checklists/stations").catch(
    () => [] as ChecklistStation[],
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-10">
        <nav aria-label="Breadcrumb" className="mb-3 text-sm">
          <Link href="/checklists/manage" className="inline-flex items-center gap-1 text-brand-600 dark:text-brand-400 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Checklists admin
          </Link>
        </nav>
        <PageTitle icon={MonitorSpeaker}>Stations</PageTitle>
        <div className="my-4"><SettingsNav label="Checklist admin pages" items={CHECKLISTS_MANAGE_NAV} /></div>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Your booths / roles (Camera, FOH, ProPresenter, Lights, Stream…). Each template is assigned
          to one station, and a day&apos;s event groups by station.
        </p>
        <StationsAdminClient initial={stations} />
      </main>
    </>
  );
}
