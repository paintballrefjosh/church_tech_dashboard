import { redirect } from "next/navigation";
import { Network } from "lucide-react";
import type { ClusterStatus } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { ClusterView } from "./cluster-view";

export const dynamic = "force-dynamic";

export default async function ClusterPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  let status: ClusterStatus | null = null;
  let error: string | null = null;
  try {
    status = await apiJson<ClusterStatus>("/api/v1/admin/cluster");
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={Network}>Cluster</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          Every app node and when it last checked in, which node runs each background job, and the health of the database and the
          object store as seen from the node that answered this page. On a single node install there is one node and it leads every job.
          Setting up more: see the installation guide, &quot;Multi node&quot;.
        </p>
        {error || !status ? (
          <p className="mt-6 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
            {error?.includes("403") ? "You need the site admin permission to see the cluster." : (error ?? "No data.")}
          </p>
        ) : (
          <div className="mt-6">
            <ClusterView initial={status} />
          </div>
        )}
      </main>
    </>
  );
}
