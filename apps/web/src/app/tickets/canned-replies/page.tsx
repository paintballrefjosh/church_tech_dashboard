import { redirect } from "next/navigation";
import Link from "next/link";
import { MessageSquareText } from "lucide-react";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { CANNED_REPLY_VARIABLES, type CannedReply } from "@church/shared";
import { CannedRepliesClient } from "./canned-replies-client";

export const dynamic = "force-dynamic";

interface MePayload {
  permissions: string[];
}

export default async function CannedRepliesPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) redirect("/change-password");

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  if (!me) redirect("/signin");
  if (!me.permissions.includes("tickets:read:any")) redirect("/tickets");
  const canWrite = me.permissions.includes("tickets:admin");

  const replies = await apiJson<CannedReply[]>("/api/v1/tickets/canned-replies").catch(() => [] as CannedReply[]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-4xl px-4 py-8">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm">
          <Link href="/tickets" className="text-brand-600 dark:text-brand-400 hover:underline">
            ← All tickets
          </Link>
        </nav>
        <PageTitle icon={MessageSquareText}>Saved replies</PageTitle>
        <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-400">
          Answers you give again and again. Pick one in the comment box of a ticket and it is filled in for you to read before you send.
          These words are replaced by the ticket&apos;s details:{" "}
          {CANNED_REPLY_VARIABLES.map((v, i) => (
            <span key={v.key}>
              {i > 0 ? ", " : ""}
              <code className="font-mono text-xs">{`{{${v.key}}}`}</code> ({v.label.toLowerCase()})
            </span>
          ))}
          .
        </p>
        <CannedRepliesClient initial={replies} canWrite={canWrite} />
      </main>
    </>
  );
}
