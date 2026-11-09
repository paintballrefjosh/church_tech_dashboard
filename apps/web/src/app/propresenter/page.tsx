import Link from "next/link";
import { redirect } from "next/navigation";
import { Presentation, Settings as SettingsIcon } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { viewerPermissions } from "@/lib/load-module-settings";
import { PropresenterClient } from "./propresenter-client";

export const dynamic = "force-dynamic";

export default async function PropresenterPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const canAdmin = (await viewerPermissions()).has("propresenter:admin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <PageTitle icon={Presentation}>ProPresenter</PageTitle>
          {canAdmin ? (
            <Link
              href="/propresenter/settings"
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
            >
              <SettingsIcon className="h-4 w-4" aria-hidden /> Settings
            </Link>
          ) : null}
        </header>
        <PropresenterClient />
      </main>
    </>
  );
}
