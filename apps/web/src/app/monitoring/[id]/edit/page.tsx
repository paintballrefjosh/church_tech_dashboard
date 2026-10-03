import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MonitorForm } from "../../monitor-form";
import type { Monitor } from "@church/shared";

export default async function EditMonitorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  const res = await apiFetch(`/api/v1/monitors/${encodeURIComponent(id)}`);
  if (res.status === 404) notFound();
  const monitor = (await res.json()) as Monitor;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link
            href={`/monitoring/${id}`}
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to monitor
          </Link>
        </nav>
        <PageTitle icon={Activity}>Edit {monitor.name}</PageTitle>
        <MonitorForm initial={monitor} />
      </main>
    </>
  );
}
