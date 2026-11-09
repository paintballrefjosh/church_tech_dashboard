import { redirect } from "next/navigation";
import Link from "next/link";
import { BarChart3, Bot, Settings as SettingsIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { viewerPermissions } from "@/lib/load-module-settings";
import { AssistantChat } from "./assistant-chat";

export const dynamic = "force-dynamic";

export const metadata = { title: "Assistant" };

export default async function AssistantPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const perms = await viewerPermissions();
  const link = "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-900";
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={Bot}>Assistant</PageTitle>
          <div className="ml-auto flex items-center gap-2">
            {perms.has("assistant:usage") ? (
              <Link href="/assistant/usage" className={link}>
                <BarChart3 className="h-4 w-4" aria-hidden /> Usage
              </Link>
            ) : null}
            {perms.has("site:admin") ? (
              <Link href="/assistant/settings" className={link}>
                <SettingsIcon className="h-4 w-4" aria-hidden /> Settings
              </Link>
            ) : null}
          </div>
        </div>
        <AssistantChat />
      </main>
    </>
  );
}
