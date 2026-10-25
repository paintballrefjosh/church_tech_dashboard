import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Server } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitoringBackdrop } from "@/components/monitoring-backdrop";

export const dynamic = "force-dynamic";

/**
 * Server and network cabinets: where each switch, host and access point sits, as an elevation, with printable sheets.
 * Part of the `monitoring` module (reads monitors:read:any, changes monitors:write:any), like IPAM and DNS. The printable
 * sheet lives outside this layout (`cabinets/[id]/print`) so it carries no navigation.
 */
export default async function CabinetsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div>
      <MonitoringBackdrop />
      <div className="fx-surface">
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-8">
          <PageTitle icon={Server}>Cabinets</PageTitle>
          <div className="mt-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
