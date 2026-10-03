import { redirect } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitorForm } from "../monitor-form";

export default async function NewMonitorPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link href="/monitoring" className="inline-flex items-center gap-1 text-brand-600 hover:underline">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to monitors
          </Link>
        </nav>
        <PageTitle icon={Activity}>New monitor</PageTitle>
        <MonitorForm />
      </main>
    </>
  );
}
