import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Server } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { InfraTargetForm } from "../infra-target-form";

export const dynamic = "force-dynamic";

export default async function NewInfraTargetPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link
          href="/monitoring/infra"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Infrastructure
        </Link>
        <PageTitle icon={Server}>Add target</PageTitle>
        <InfraTargetForm />
      </main>
    </>
  );
}
