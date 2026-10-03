import { redirect } from "next/navigation";
import { UsersRound } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { UsersAdminClient } from "./users-admin-client";

export const dynamic = "force-dynamic";

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  isActive: boolean;
  totpEnabled: boolean;
  approvalStatus: "approved" | "pending";
  isExternal: boolean;
  deletedAt: string | null;
  createdAt: string;
}
interface GroupRow {
  id: string;
  name: string;
  description: string | null;
}
interface MePayload {
  permissions: string[];
}

export default async function AdminUsersPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  const canWrite = me?.permissions?.includes("user:admin") ?? false;
  // Hard-delete is irreversible, so it's gated to the highest privilege.
  const canHardDelete = me?.permissions?.includes("site:admin") ?? false;

  const [users, groups] = await Promise.all([
    apiJson<UserRow[]>("/api/v1/users").catch(() => [] as UserRow[]),
    apiJson<GroupRow[]>("/api/v1/groups").catch(() => [] as GroupRow[]),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={UsersRound}>Users</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Every account on the system, including users provisioned via Google OAuth. Click
          Manage on a row to edit display name, active state, and group memberships.
        </p>
        <UsersAdminClient
          initialUsers={users}
          groups={groups}
          canWrite={canWrite}
          canHardDelete={canHardDelete}
        />
      </main>
    </>
  );
}
