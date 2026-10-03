import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Activity } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitoringTabs } from "../section-tabs";
import { CiscoTabs } from "./cisco-tabs";

export const dynamic = "force-dynamic";

export default async function CiscoLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Activity}>Monitoring</PageTitle>
        <MonitoringTabs />
        <CiscoTabs />
        {children}
      </main>
    </>
  );
}
