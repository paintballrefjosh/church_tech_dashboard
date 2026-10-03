import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

type Tier = "user" | "moderator" | "admin";

interface ModuleSpec {
  key: string;
  label: string;
  description: string;
  tiers: readonly Tier[];
}

interface GroupSpec {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  access: Record<string, Tier>;
}

interface Matrix {
  modules: ModuleSpec[];
  groups: GroupSpec[];
}

const TIER_LABEL: Record<Tier, string> = {
  user: "User",
  moderator: "Mod",
  admin: "Admin",
};
const TIER_BG: Record<Tier, string> = {
  user: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-100",
  moderator: "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100",
  admin: "bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100",
};

export default async function AdminPermissionsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const matrix = await apiJson<Matrix>("/api/v1/groups/matrix").catch(() => null);
  if (!matrix) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-10">
          <PageTitle icon={KeyRound}>Access matrix</PageTitle>
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Couldn't load the matrix. You may not have <code className="font-mono">permissions:read:any</code>.
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={KeyRound}>Access matrix</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Read-only view of every group's tier per module. Edit assignments at{" "}
          <a href="/admin/groups" className="text-brand-600 underline">/admin/groups</a>.
        </p>

        <div className="mt-6 overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
          <table className="min-w-full border-collapse text-xs">
            <thead className="bg-slate-50 dark:bg-slate-900/40">
              <tr>
                <th className="sticky left-0 bg-slate-50 px-3 py-2 text-left font-medium dark:bg-slate-900/40">
                  Module
                </th>
                {matrix.groups.map((g) => (
                  <th key={g.id} className="px-3 py-2 text-center font-medium">
                    {g.name}
                    {g.isSystem ? (
                      <span className="ml-1 text-[10px] uppercase tracking-wide text-slate-400">
                        system
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.modules.map((m, i) => (
                <tr
                  key={m.key}
                  className={i % 2 === 0 ? "" : "bg-slate-50/50 dark:bg-slate-900/20"}
                >
                  <td className="sticky left-0 bg-inherit px-3 py-1.5">
                    <div className="font-medium">{m.label}</div>
                    <div className="font-mono text-[10px] text-slate-500">{m.key}</div>
                  </td>
                  {matrix.groups.map((g) => {
                    const tier = g.access[m.key];
                    return (
                      <td key={g.id} className="px-3 py-1.5 text-center">
                        {tier ? (
                          <span
                            className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${TIER_BG[tier]}`}
                          >
                            {TIER_LABEL[tier]}
                          </span>
                        ) : (
                          <span aria-hidden className="text-slate-300 dark:text-slate-700">
                            ·
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
