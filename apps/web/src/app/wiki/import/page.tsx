import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { FileUp } from "lucide-react";
import { ImportWikiForm } from "./import-wiki-form";

export const dynamic = "force-dynamic";

interface GroupBrief {
  id: string;
  name: string;
}

export default async function ImportWikiPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const groups = await apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={FileUp}>Import a file</PageTitle>
        <p className="mt-2 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Converts a Word doc, plain text file, or PDF into a new wiki page. This gets the
          content and images in as a starting draft — you'll land in the editor afterward to
          review and polish it.
        </p>
        <Suspense fallback={null}>
          <ImportWikiForm groups={groups} />
        </Suspense>
      </main>
    </>
  );
}
