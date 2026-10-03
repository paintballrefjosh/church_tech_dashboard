import { redirect } from "next/navigation";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { AdminLinksClient } from "./admin-links-client";

interface UserBrief {
  id: string;
  email: string;
  name: string | null;
}
interface LinkRow {
  userId: string;
  userEmail: string;
  userName: string | null;
  pcPersonId: string;
  pcEmail: string | null;
  pcFirstName: string | null;
  pcLastName: string | null;
  updatedAt: string;
}

export const dynamic = "force-dynamic";

export default async function AdminPlanningCenterPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [users, links, health] = await Promise.all([
    apiJson<UserBrief[]>("/api/v1/users").catch(() => [] as UserBrief[]),
    apiJson<LinkRow[]>("/api/v1/planning-center/links").catch(() => [] as LinkRow[]),
    apiJson<{ configured: boolean; reachable: boolean; error: string | null }>(
      "/api/v1/planning-center/health",
    ).catch(() => ({ configured: false, reachable: false, error: null })),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={CalendarDays}>Planning Center links</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Map local users to Planning Center people. Used by the dashboard tile + service
          detail to highlight assignments that belong to a known local user. Users can self-link
          on their <Link href="/me" className="text-brand-600 underline">profile</Link>.
        </p>

        {!health.configured ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            Planning Center isn&apos;t configured.{" "}
            <Link href="/admin/settings/planning_center" className="underline">
              Configure
            </Link>{" "}
            it first.
          </p>
        ) : null}

        <div className="mt-6">
          <AdminLinksClient initialLinks={links} users={users} />
        </div>
      </main>
    </>
  );
}
