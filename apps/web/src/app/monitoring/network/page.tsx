import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, Settings as SettingsIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitoringTabs } from "../section-tabs";
import { NetworkClient } from "./network-client";

export const dynamic = "force-dynamic";

export default async function NetworkPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            UniFi devices and clients reported by the Network controller.
          </p>
          <Link
            href="/admin/settings/monitoring"
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            <SettingsIcon className="h-4 w-4" aria-hidden />
            UniFi config
          </Link>
        </header>
        <NetworkClient />
      </main>
    </>
  );
}
