import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiFetch, apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { Markdown } from "@/components/markdown";
import { AttachmentList } from "@/components/attachment-list";
import { WikiPageActions } from "./wiki-page-actions";
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
        <main className="mx-auto max-w-4xl px-4 py-8">
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Couldn't load page ({res.status}).
          </p>
        </main>
      </>
    );
  }
  const payload = (await res.json()) as PagePayload;

  const groups: GroupBrief[] = payload.acl.length
    ? await apiJson<GroupBrief[]>("/api/v1/groups").catch(() => [] as GroupBrief[])
    : [];
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  return (
    <>
      <TopBar />
      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[1fr_240px]">
        <article>
          <nav className="mb-3 text-sm">
            <Link href="/wiki" className="text-brand-600 hover:underline">
              ← All pages
            </Link>
          </nav>
          <header className="mb-6">
            <h1 className="text-3xl font-semibold">{payload.page.title}</h1>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              updated {new Date(payload.page.updatedAt).toLocaleString()}
              {payload.page.visibility === "group" ? " · restricted" : ""}
            </p>
          </header>
          {payload.page.body.trim() ? (
            <Markdown>{payload.page.body}</Markdown>
          ) : (
            <p className="italic text-slate-400">(empty page)</p>
          )}

          <section className="mt-8 border-t border-slate-200 pt-4 dark:border-slate-800">
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

        <aside className="space-y-4 rounded-md border border-slate-200 p-4 text-sm dark:border-slate-800">
          <WikiPageActions
            pageId={payload.page.id}
            canEdit={payload.canEdit}
            canDelete={payload.canDelete}
          />
          <Field label="Visibility">
            <span>{payload.page.visibility === "public" ? "Public" : "Restricted"}</span>
          </Field>
          {payload.acl.length ? (
            <Field label="Access">
              <ul className="space-y-1">
                {payload.acl.map((a) => (
                  <li key={a.groupId} className="text-slate-600 dark:text-slate-300">
                    {groupMap.get(a.groupId)?.name ?? a.groupId.slice(0, 8)}{" "}
                    <span className="text-xs text-slate-500">
                      ({a.canEdit ? "read + edit" : "read"})
                    </span>
                  </li>
                ))}
              </ul>
            </Field>
          ) : null}
        </aside>
      </main>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
