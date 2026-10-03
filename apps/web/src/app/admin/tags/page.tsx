import { redirect } from "next/navigation";
import { Tags } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { Tag } from "@church/shared";
import { TagsAdminClient } from "./tags-admin-client";

export const dynamic = "force-dynamic";

export default async function AdminTagsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const tags = await apiJson<Tag[]>("/api/v1/tags").catch(() => [] as Tag[]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={Tags}>Tags</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Tags can be applied to tickets, notes, and wiki pages. Anyone can use a tag they
          can read; admins can rename/recolour or delete them.
        </p>
        <TagsAdminClient initial={tags} />
      </main>
    </>
  );
}
