import { redirect } from "next/navigation";
import { Printer } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import type { Printer as PrinterRow } from "@church/shared";
import { PrintersList } from "./printers-list";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions?: string[];
}

export default async function PrintersPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  const [printers, me] = await Promise.all([
    apiJson<PrinterRow[]>("/api/v1/printers").catch(() => [] as PrinterRow[]),
    apiJson<MePayload>("/api/v1/me").catch(() => null),
  ]);
  const perms = new Set(me?.permissions ?? []);
  const canAdmin = perms.has("printers:admin");
  const canRead = perms.has("printers:read:any") || canAdmin;

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Printer}>Printers</PageTitle>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Live status, toner / ink levels, paper trays, and (for Fiery servers) the active
          queue depth. Background poll runs every few minutes; use Refresh on a card to
          re-check immediately.
        </p>
        {!canRead ? (
          <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            You don't have <code className="font-mono">printers:read:any</code>. Ask an admin.
          </p>
        ) : (
          <PrintersList initial={printers} canAdmin={canAdmin} />
        )}
      </main>
    </>
  );
}
