import { redirect } from "next/navigation";
import { Users } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { GroupsAdminClient } from "./groups-admin-client";
import { MODULES } from "@church/shared";

export const dynamic = "force-dynamic";

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  googleGroupEmail: string | null;
  isManaged: boolean;
  isSystem: boolean;
  createdAt: string;
}
interface UserRow {
  id: string;
  email: string;
  name: string | null;
  isActive?: boolean;
  deletedAt?: string | null;
}
interface MePayload {
  permissions: string[];
}

export default async function AdminGroupsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const canWrite = me?.permissions?.includes("user:admin") ?? false;

  const [groups, users] = await Promise.all([
    apiJson<GroupRow[]>("/api/v1/groups").catch(() => [] as GroupRow[]),
    apiJson<UserRow[]>("/api/v1/users").catch(() => [] as UserRow[]),
  ]);
  // The catalog of modules lives in shared and is a compile-time constant;
  // no round-trip needed.
  const modules = MODULES.map((m) => ({
    key: m.key,
    label: m.label,
    description: m.description,
    tiers: m.tiers,
  }));

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={Users}>Groups</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Assign each group access to zero or more modules at a chosen tier
          (user / moderator / admin). Members inherit the highest tier across
          the groups they belong to. The <code className="font-mono">admin</code>
          group always has admin tier on every module and cannot be edited or
          deleted; the <code className="font-mono">user</code> group is the
          default for OAuth provisioning and cannot be deleted.
        </p>
        <GroupsAdminClient
          initialGroups={groups}
          modules={modules}
          users={users}
          canWrite={canWrite}
        />
      </main>
    </>
  );
}
