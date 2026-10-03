import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { FilePlus } from "lucide-react";
import { NewWikiForm } from "./new-wiki-form";

export const dynamic = "force-dynamic";

interface GroupBrief {
  id: string;
  name: string;
}

export default async function NewWikiPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  // Loading groups so the ACL editor can offer them. Empty if the caller
  // doesn't have groups:read:any (forbidden) — the form falls back to
  // public-only in that case.
  const groups = await apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={FilePlus}>New wiki page</PageTitle>
        <Suspense fallback={null}>
          <NewWikiForm groups={groups} />
        </Suspense>
      </main>
    </>
  );
}
