import { redirect } from "next/navigation";
import { KeySquare } from "lucide-react";
import { MODULES, type ApiTokenPolicy, type ApiTokenSummary } from "@church/shared";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { MyTokensClient } from "./my-tokens-client";

interface Me {
  permissions: string[];
  access: Record<string, string>;
}

export const dynamic = "force-dynamic";

export default async function ApiTokensPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [me, tokens, policy] = await Promise.all([
    apiJson<Me>("/api/v1/me"),
    apiJson<ApiTokenSummary[]>("/api/v1/me/api-tokens"),
    apiJson<ApiTokenPolicy>("/api/v1/me/api-tokens/policy"),
  ]);
  // Only modules this user can reach: a token can never add access.
  const modules = MODULES.filter((m) => me.access[m.key]).map((m) => ({ key: m.key, label: m.label }));
  const isSiteAdmin = me.permissions.includes("site:admin") || me.permissions.includes("user:admin");

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <PageTitle icon={KeySquare}>API tokens</PageTitle>
        <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-400">
          A token lets a script or an AI agent use the dashboard&apos;s API as you. Send it as{" "}
          <code className="font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>. It can
          never do more than you can, and you can narrow it further: read-only, or only certain
          modules. Revoke a token as soon as you stop using it.
        </p>
        <MyTokensClient
          initialTokens={tokens}
          policy={policy}
          modules={modules}
          warnFullAccess={isSiteAdmin}
        />
      </main>
    </>
  );
}
