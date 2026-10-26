import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitoringTabs } from "../../section-tabs";
import { ServiceTemplatesClient } from "./templates-client";

export const dynamic = "force-dynamic";

/** The service templates (built-in and custom) and the saved logins they use (docs/service-monitoring.md). */
export default async function ServiceTemplatesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <ServiceTemplatesClient />
      </main>
    </>
  );
}
