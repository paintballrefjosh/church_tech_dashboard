import Link from "next/link";
import { redirect } from "next/navigation";
import { DatabaseBackup } from "lucide-react";
import type { BackupOperation, BackupSchedule, BackupStorageInfo, BackupSummary } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { BackupsPanel } from "./backups-panel";
import { SchedulesPanel } from "./schedules-panel";
import { RestorePanel } from "./restore-panel";

export const dynamic = "force-dynamic";

const TABS = [
  { key: "backups", label: "Backups" },
  { key: "schedules", label: "Schedules" },
  { key: "restore", label: "Restore" },
] as const;
type Tab = (typeof TABS)[number]["key"];

export default async function BackupsPage({ searchParams }: { searchParams: Promise<{ tab?: string; backup?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const sp = await searchParams;
  const tab: Tab = (TABS.map((t) => t.key) as string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "backups";

  let backups: BackupSummary[] = [];
  let schedules: BackupSchedule[] = [];
  let storage: BackupStorageInfo | null = null;
  let operations: BackupOperation[] = [];
  let error: string | null = null;
  try {
    [backups, schedules, storage, operations] = await Promise.all([
      apiJson<BackupSummary[]>("/api/v1/admin/backups"),
      apiJson<BackupSchedule[]>("/api/v1/admin/backups/schedules"),
      apiJson<BackupStorageInfo>("/api/v1/admin/backups/storage").catch(() => null),
      apiJson<BackupOperation[]>("/api/v1/admin/backups/operations?limit=10"),
    ]);
  } catch (e) {
    error = (e as Error).message;
  }
  const running = operations.find((o) => o.status === "running") ?? null;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={DatabaseBackup}>Backups</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          Back up everything this site holds, on a schedule or on demand, download copies to keep offline, and roll the whole site back to
          any of them. For database-level backups of the underlying servers see the installation guide; this page is the safety net for
          &quot;somebody deleted something&quot; and &quot;we need to go back to how it was last week&quot;.
        </p>

        <nav className="mt-6 flex gap-1 border-b border-slate-300 text-sm dark:border-slate-800" aria-label="Backup sections">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.key === "backups" ? "/admin/backups" : `/admin/backups?tab=${t.key}`}
              className={`mb-[-1px] border-b-2 px-3 py-2 ${
                tab === t.key
                  ? "border-brand-600 text-brand-700 dark:text-brand-300"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
              aria-current={tab === t.key ? "page" : undefined}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        {error ? (
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
            {error.includes("403") ? "You need the site admin permission to manage backups." : error}
          </p>
        ) : (
          <div className="mt-5">
            {tab === "backups" ? <BackupsPanel initialBackups={backups} storage={storage} runningOperation={running} /> : null}
            {tab === "schedules" ? <SchedulesPanel initialSchedules={schedules} runningOperation={running} /> : null}
            {tab === "restore" ? <RestorePanel initialBackups={backups} initialSelected={sp.backup ?? null} runningOperation={running} /> : null}
          </div>
        )}
      </main>
    </>
  );
}
