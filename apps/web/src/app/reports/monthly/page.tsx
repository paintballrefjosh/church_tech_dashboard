import { redirect } from "next/navigation";
import { FileBarChart } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ReportClient } from "./report-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Monthly report" };

/** The monthly report for any month. Site admins and the report's group (Site settings > Monthly report); the API decides. */
export default async function MonthlyReportPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { month } = await searchParams;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <PageTitle icon={FileBarChart}>Monthly report</PageTitle>
        <ReportClient initialMonth={month && /^\d{4}-\d{2}$/.test(month) ? month : null} />
      </main>
    </>
  );
}
