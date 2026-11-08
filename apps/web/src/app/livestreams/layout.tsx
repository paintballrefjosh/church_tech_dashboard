import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { MonitoringBackdrop } from "@/components/monitoring-backdrop";

export const dynamic = "force-dynamic";

/**
 * Livestreams (the `livestreams` module, docs/livestreams.md). Each page draws its own title. Shares the Monitoring
 * section's network-graph backdrop, so the header and cards sit over the same ambient field as the other pages.
 */
export default async function LivestreamsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div>
      <MonitoringBackdrop />
      <div className="fx-surface">
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>
    </div>
  );
}
