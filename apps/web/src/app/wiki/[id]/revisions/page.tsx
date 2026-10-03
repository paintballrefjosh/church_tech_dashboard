import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { RevisionsView } from "./revisions-view";

export const dynamic = "force-dynamic";

interface Revision {
  id: string;
  pageId: string;
  title: string;
  body: string;
  editorUserId: string | null;
  editorName: string | null;
  editorEmail: string | null;
  summary: string | null;
  createdAt: string;
}

interface PagePayload {
  page: { id: string; title: string; body: string };
  canEdit: boolean;
}

/**
 * Revisions list + diff viewer for a single wiki page. Fetches the current
 * page body server-side so the diff comparison happens against fresh state.
 * The client component handles selection + revert.
 */
export default async function WikiRevisionsPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  const [page, revisions] = await Promise.all([
    apiJson<PagePayload>(`/api/v1/wiki/${encodeURIComponent(id)}`).catch(() => null),
    apiJson<Revision[]>(`/api/v1/wiki/${encodeURIComponent(id)}/revisions`).catch(() => [] as Revision[]),
  ]);
  if (!page) notFound();

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Link
          href={`/wiki/${id}`}
          className="text-xs text-slate-500 hover:underline"
        >
          ← Back to page
        </Link>
        <h1 className="mt-2 text-2xl font-semibold">{page.page.title}</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          History — click a revision to see what changed.
        </p>
        <div className="mt-6">
          <RevisionsView
            pageId={id}
            currentBody={page.page.body}
            currentTitle={page.page.title}
            canEdit={page.canEdit}
            revisions={revisions}
          />
        </div>
      </main>
    </>
  );
}
