import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { NewWikiForm } from "./new-wiki-form";

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
      <main className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="text-2xl font-semibold">New wiki page</h1>
        <NewWikiForm groups={groups} />
      </main>
    </>
  );
}
