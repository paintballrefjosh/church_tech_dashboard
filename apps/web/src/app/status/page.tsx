import { redirect } from "next/navigation";
import { Radio } from "lucide-react";
import type { StatusPage } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { StatusClient } from "./status-client";

export const dynamic = "force-dynamic";

export const metadata = { title: "Status" };

export default async function StatusRoute({ searchParams }: { searchParams: Promise<{ kiosk?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { kiosk } = await searchParams;
  const initial = await apiJson<StatusPage>("/api/v1/status").catch(() => null);

  return (
    <>
      <TopBar kiosk={kiosk === "1"} />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <header className="mb-6">
          <PageTitle icon={Radio}>Status</PageTitle>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            What is working right now. This updates by itself; if something here is down, the people who look after it have been told.
          </p>
        </header>
        <StatusClient initial={initial} />
      </main>
    </>
  );
}
