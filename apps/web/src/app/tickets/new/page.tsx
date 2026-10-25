import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { LifeBuoy } from "lucide-react";
import { apiJson } from "@/lib/api";
import type { Asset } from "@church/shared";
import { NewTicketForm } from "./new-ticket-form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?room=<id>` (a room sign's code) and `?asset=<id>` (an item's "report a problem") fill those in. */
export default async function NewTicketPage({ searchParams }: { searchParams: Promise<{ room?: string; asset?: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const sp = await searchParams;
  const room = sp.room && UUID.test(sp.room) ? sp.room : null;
  // An item the person may not read (no Equipment module) is simply not filled in.
  const asset = sp.asset && UUID.test(sp.asset) ? await apiJson<Asset>(`/api/v1/assets/${sp.asset}`).catch(() => null) : null;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={LifeBuoy}>New ticket</PageTitle>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Describe what you need help with. Support engineers will see it.
        </p>
        <NewTicketForm roomId={room ?? asset?.location?.id ?? null} asset={asset ? { id: asset.id, tag: asset.tag, name: asset.name } : null} />
      </main>
    </>
  );
}
