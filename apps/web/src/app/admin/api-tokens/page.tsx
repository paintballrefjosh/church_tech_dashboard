import Link from "next/link";
import { redirect } from "next/navigation";
import { KeySquare } from "lucide-react";
import { API_TOKEN_STATUSES, type ApiTokenAdminSummary, type ApiTokenStatus } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { AdminTokensClient } from "./admin-tokens-client";

const FILTERS: Array<{ key: ApiTokenStatus | "all"; label: string }> = [
  { key: "active", label: "Active" },
  { key: "expired", label: "Expired" },
  { key: "revoked", label: "Revoked" },
  { key: "all", label: "All" },
];

export const dynamic = "force-dynamic";

export default async function AdminApiTokensPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const sp = await searchParams;
  const status = (API_TOKEN_STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as ApiTokenStatus)
    : sp.status === "all"
      ? "all"
      : "active";

  let tokens: ApiTokenAdminSummary[] = [];
  let error: string | null = null;
  try {
    tokens = await apiJson<ApiTokenAdminSummary[]>(
      `/api/v1/admin/api-tokens${status === "all" ? "" : `?status=${status}`}`,
    );
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={KeySquare}>API tokens</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          Every user&apos;s API tokens. A token acts as its owner, so revoke any you don&apos;t
          recognise. To give a script or an agent its own identity, create a user for it and
          issue the token from that user&apos;s page in{" "}
          <Link href="/admin/users" className="text-brand-600 hover:underline dark:text-brand-400">
            Users
          </Link>
          . Lifetime limits and the on/off switch are in{" "}
          <Link href="/admin/settings/auth" className="text-brand-600 hover:underline dark:text-brand-400">
            Auth settings
          </Link>
          .
        </p>

        <nav className="mt-6 flex gap-1 border-b border-slate-300 text-sm dark:border-slate-800">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={f.key === "active" ? "/admin/api-tokens" : `/admin/api-tokens?status=${f.key}`}
              className={`mb-[-1px] border-b-2 px-3 py-2 ${
                status === f.key
                  ? "border-brand-600 text-brand-700 dark:text-brand-300"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>

        {error ? (
          <p className="mt-4 rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300">
            {error.includes("403") ? "You need the user admin permission to see API tokens." : error}
          </p>
        ) : (
          <div className="mt-4">
            <AdminTokensClient key={status} initialTokens={tokens} />
          </div>
        )}
      </main>
    </>
  );
}
