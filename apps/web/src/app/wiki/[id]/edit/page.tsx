import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { EditWikiForm } from "./edit-wiki-form";
import type { WikiPage } from "@church/shared";

export const dynamic = "force-dynamic";

interface PagePayload {
  page: WikiPage;
  acl: Array<{ groupId: string; canEdit: boolean }>;
  canEdit: boolean;
  canDelete: boolean;
}

interface GroupBrief {
  id: string;
  name: string;
}

export default async function EditWikiPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const { id } = await params;

  const res = await apiFetch(`/api/v1/wiki/${encodeURIComponent(id)}`);
  if (res.status === 404 || res.status === 403) notFound();
  if (!res.ok) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-4xl px-4 py-8">
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Couldn't load page ({res.status}).
          </p>
        </main>
      </>
    );
  }
  const payload = (await res.json()) as PagePayload;
  if (!payload.canEdit) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-3xl px-4 py-8">
          <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            You don't have permission to edit this page.{" "}
            <Link href={`/wiki/${id}`} className="underline">
              Back to view
            </Link>
          </p>
        </main>
      </>
    );
  }
  const groups = await apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[]);
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-8">
        <nav className="mb-3 text-sm">
          <Link href={`/wiki/${id}`} className="text-brand-600 hover:underline">
            ← Back to page
          </Link>
        </nav>
        <h1 className="text-2xl font-semibold">Edit “{payload.page.title}”</h1>
        <EditWikiForm
          page={payload.page}
          initialAcl={payload.acl}
          groups={groups}
        />
      </main>
    </>
  );
}
