import { redirect } from "next/navigation";
import { Suspense } from "react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { FilePlus } from "lucide-react";
import { WIKI_STARTER_TEMPLATES, type WikiTemplate } from "@church/shared";
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
  const [groups, saved] = await Promise.all([
    apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[]),
    apiJson<WikiTemplate[]>("/api/v1/wiki/templates").catch(() => [] as WikiTemplate[]),
  ]);
  const templates = [
    ...WIKI_STARTER_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, body: t.body, builtIn: true })),
    ...saved.map((t) => ({ id: t.id, name: t.name, description: t.description, body: t.body, builtIn: false })),
  ];
  const author = session.user.name ?? session.user.email ?? "";
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={FilePlus}>New wiki page</PageTitle>
        <Suspense fallback={null}>
          <NewWikiForm groups={groups} templates={templates} author={author} />
        </Suspense>
      </main>
    </>
  );
}
