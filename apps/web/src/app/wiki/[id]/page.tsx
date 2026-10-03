import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { Markdown } from "@/components/markdown";
import { AttachmentList } from "@/components/attachment-list";
import { LocalDateTime } from "@/components/local-date-time";
import { WikiPageToolbar } from "./wiki-page-toolbar";
import { WikiEditHotkey } from "./wiki-edit-hotkey";
import { WikiTreeSidebar } from "../wiki-tree-sidebar";
import { WikiSidebarPane } from "../wiki-sidebar-pane";
import { ancestorChain } from "../wiki-tree-utils";
import type { WikiPage, WikiTreeNode } from "@church/shared";

export const dynamic = "force-dynamic";

interface PagePayload {
  page: WikiPage;
  acl: Array<{ groupId: string; canEdit: boolean }>;
  canEdit: boolean;
  canDelete: boolean;
  updatedBy: { id: string; name: string | null; email: string } | null;
}

interface GroupBrief {
  id: string;
  name: string;
}

export default async function ViewWikiPage({ params }: { params: Promise<{ id: string }> }) {
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
        <main className="mx-auto max-w-6xl px-4 py-8">
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Couldn't load page ({res.status}).
          </p>
        </main>
      </>
    );
  }
  const payload = (await res.json()) as PagePayload;

  const [groups, tree] = await Promise.all([
    payload.acl.length
      ? apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[])
      : Promise.resolve([] as GroupBrief[]),
    apiJson<WikiTreeNode[]>("/api/v1/wiki/tree").catch(() => [] as WikiTreeNode[]),
  ]);
  const groupMap = new Map(groups.map((g) => [g.id, g]));
  const breadcrumbs = ancestorChain(tree, payload.page.id);
  const acl = payload.acl.map((a) => ({
    ...a,
    groupName: groupMap.get(a.groupId)?.name ?? a.groupId.slice(0, 8),
  }));

  return (
    <>
      <TopBar />
      <WikiEditHotkey pageId={payload.page.id} canEdit={payload.canEdit} />
      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* Tree sidebar renders again here (rather than living in a shared
            layout) so /wiki/new, /wiki/[id]/edit and /wiki/[id]/revisions keep
            their existing full-width layout untouched — only the list (/wiki)
            and this view route get the persistent-menu split pane. */}
        <div className="gap-6 md:flex">
          <WikiSidebarPane>
            <WikiTreeSidebar tree={tree} activeId={payload.page.id} />
          </WikiSidebarPane>
          <section className="mt-6 min-w-0 flex-1 md:mt-0">
            <article>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <nav
                  className="flex flex-wrap items-center gap-1 text-sm text-slate-500 dark:text-slate-400"
                  aria-label="Breadcrumb"
                >
                  <Link href="/wiki" className="text-brand-600 hover:underline">
                    Wiki
                  </Link>
                  {breadcrumbs.map((b) => (
                    <span key={`${b.kind}:${b.id}`} className="flex items-center gap-1">
                      <span aria-hidden>/</span>
                      {b.kind === "page" ? (
                        <Link href={`/wiki/${b.id}`} className="text-brand-600 hover:underline">
                          {b.label}
                        </Link>
                      ) : (
                        <span>{b.label}</span>
                      )}
                    </span>
                  ))}
                </nav>

                <WikiPageToolbar
                  pageId={payload.page.id}
                  canEdit={payload.canEdit}
                  canDelete={payload.canDelete}
                  visibility={payload.page.visibility}
                  acl={acl}
                />
              </div>
              <header className="mb-4">
                <h1 className="text-3xl font-semibold">{payload.page.title}</h1>
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  updated <LocalDateTime value={payload.page.updatedAt} />
                  {payload.updatedBy ? (
                    <> by {payload.updatedBy.name ?? payload.updatedBy.email}</>
                  ) : null}
                </p>
              </header>

              {payload.page.body.trim() ? (
                <Markdown>{payload.page.body}</Markdown>
              ) : (
                <p className="italic text-slate-400">(empty page)</p>
              )}

              <section className="mt-8 border-t border-slate-300 pt-4 dark:border-slate-800">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Attachments
                </h2>
                <AttachmentList
                  baseUrl={`/api/wiki/${payload.page.id}/attachments`}
                  canEdit={payload.canEdit}
                  layout="row"
                />
              </section>
            </article>
          </section>
        </div>
      </main>
    </>
  );
}
