import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Globe, Settings } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitoringBackdrop } from "@/components/monitoring-backdrop";

export const dynamic = "force-dynamic";

/**
 * The Technitium DNS cluster: health, query stats, zones and records, IPAM sync.
 * Its own IT menu entry since 2026-10-04 (it used to be a Monitoring tab; the
 * old /monitoring/dns URLs redirect here). Still part of the `monitoring`
 * module: reads need monitors:read:any, writes monitors:write:any. Shares the
 * Monitoring section's network-graph backdrop.
 */
export default async function DnsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  // Its settings live in the Monitoring category, which needs monitors:write:any.
  const me = await apiJson<{ permissions: string[] }>("/api/v1/me").catch(() => null);
  const canAdmin = me?.permissions.includes("monitors:write:any") ?? false;
  return (
    <div>
      <MonitoringBackdrop />
      <div className="fx-surface">
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-8">
          <div className="flex items-center justify-between gap-3">
            <PageTitle icon={Globe}>DNS</PageTitle>
            {canAdmin ? (
              <Link
                href="/admin/settings/monitoring#dns.primary_url"
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Settings className="h-4 w-4" aria-hidden /> DNS admin
              </Link>
            ) : null}
          </div>
          <div className="mt-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
