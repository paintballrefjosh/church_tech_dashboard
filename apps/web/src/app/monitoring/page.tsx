import Link from "next/link";
import { redirect } from "next/navigation";
import { Activity, Plus } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { Monitor } from "@church/shared";
import { ServicesBanner } from "./services-banner";
import { MonitorsLiveList } from "./monitors-live-list";
import { MonitoringTabs } from "./section-tabs";

export const dynamic = "force-dynamic";

export default async function MonitoringPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  // SSR fetch keeps the first paint identical to the old behaviour. The
  // MonitorsLiveList client then takes over and polls every 5s so subsequent
  // status/latency changes appear without a page refresh.
  const monitors = await apiJson<Monitor[]>("/api/v1/monitors").catch(() => [] as Monitor[]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Up/down and latency for services you probe over ICMP, TCP, or HTTP.
          </p>
          <div className="ml-auto">
            <Link
              href="/monitoring/new"
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
            >
              <Plus className="h-4 w-4" aria-hidden /> New monitor
            </Link>
          </div>
        </header>

        <ServicesBanner />

        <MonitorsLiveList initial={monitors} />
      </main>
    </>
  );
}
