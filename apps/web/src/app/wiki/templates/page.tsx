import { redirect } from "next/navigation";
import Link from "next/link";
import { LayoutTemplate } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { WIKI_STARTER_TEMPLATES, WIKI_TEMPLATE_VARIABLES, type WikiTemplate } from "@church/shared";
import { TemplatesClient } from "./templates-client";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions: string[];
}

export default async function WikiTemplatesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) redirect("/change-password");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  if (!me) redirect("/signin");
  if (!me.permissions.includes("wiki:read:own")) redirect("/");
  const canWrite = me.permissions.includes("wiki:admin");

  const saved = await apiJson<WikiTemplate[]>("/api/v1/wiki/templates").catch(() => [] as WikiTemplate[]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <nav className="mb-4 text-sm">
          <Link href="/wiki" className="text-brand-600 hover:underline">
            ← Wiki
          </Link>
        </nav>
        <PageTitle icon={LayoutTemplate}>Page templates</PageTitle>
        <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Outlines to start a new page from. Choose one on the New page screen; the page is yours to change.{" "}
          {WIKI_TEMPLATE_VARIABLES.map((v, i) => (
            <span key={v.name}>
              {i > 0 ? " and " : "These words are filled in: "}
              <code className="font-mono text-xs">{`{{${v.name}}}`}</code> ({v.description})
            </span>
          ))}
          .
        </p>
        <TemplatesClient builtIn={[...WIKI_STARTER_TEMPLATES]} initial={saved} canWrite={canWrite} />
      </main>
    </>
  );
}
