import { redirect } from "next/navigation";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { viewerPermissions } from "@/lib/load-module-settings";
import { ModuleSettingsPage } from "@/components/module-settings";
import { AdminLinksClient } from "./links-client";
import { PLANNING_CENTER_SETTINGS_NAV } from "../nav";

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

/** Which local account is which Planning Center person (docs/module-settings.md: moved here from Admin). */
export default async function PlanningCenterLinksPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const perms = await viewerPermissions();
  const intro = (
    <>
      Map local users to Planning Center people. Used by the dashboard tile + service detail to highlight assignments that belong to a known local user.
      Users can self-link on their{" "}
      <Link href="/me" className="text-brand-600 underline dark:text-brand-400">
        profile
      </Link>
      .
    </>
  );
  if (!perms.has("planning_center:admin")) {
    return (
      <ModuleSettingsPage chrome back={{ href: "/planning-center", label: "Planning Center" }} title="Planning Center links" icon={CalendarDays}>
        <p className="text-sm text-slate-600 dark:text-slate-300">Only a Planning Center admin can change these.</p>
      </ModuleSettingsPage>
    );
  }

  const [users, links, health] = await Promise.all([
    apiJson<UserBrief[]>("/api/v1/users").catch(() => [] as UserBrief[]),
    apiJson<LinkRow[]>("/api/v1/planning-center/links").catch(() => [] as LinkRow[]),
    apiJson<{ configured: boolean; reachable: boolean; error: string | null }>("/api/v1/planning-center/health").catch(() => ({ configured: false, reachable: false, error: null })),
  ]);

  return (
    <ModuleSettingsPage chrome back={{ href: "/planning-center", label: "Planning Center" }} title="Planning Center links" icon={CalendarDays} nav={PLANNING_CENTER_SETTINGS_NAV} intro={intro}>
      {!health.configured ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
          Planning Center isn&apos;t configured.{" "}
          <Link href="/planning-center/settings" className="underline">
            Configure
          </Link>{" "}
          it first.
        </p>
      ) : null}
      <AdminLinksClient initialLinks={links} users={users} />
    </ModuleSettingsPage>
  );
}
