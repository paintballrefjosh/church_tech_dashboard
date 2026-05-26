import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/lib/auth";
import { apiJson, apiFetch } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { TicketDetail } from "./ticket-detail";
import type { Ticket, TicketComment } from "@church/shared";

export const dynamic = "force-dynamic";

interface MePayload {
  id: string;
  email: string;
  name: string | null;
  permissions: string[];
}

interface UserBrief {
  id: string;
  email: string;
  name: string | null;
}

export default async function TicketDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const { id } = await params;

  const me = await apiJson<MePayload>("/api/v1/me").catch(() => null);
  if (!me) redirect("/signin");
  const perms = new Set(me.permissions);

  const ticketRes = await apiFetch(`/api/v1/tickets/${encodeURIComponent(id)}`);
  if (ticketRes.status === 404 || ticketRes.status === 403) notFound();
  if (!ticketRes.ok) {
    return (
      <>
        <TopBar />
        <main className="mx-auto max-w-3xl px-4 py-8">
          <p className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300">
            Couldn't load ticket ({ticketRes.status}).
          </p>
        </main>
      </>
    );
  }
  const ticket = (await ticketRes.json()) as Ticket;

  const [comments, users] = await Promise.all([
    apiJson<TicketComment[]>(`/api/v1/tickets/${encodeURIComponent(id)}/comments`).catch(
      () => [] as TicketComment[],
    ),
    perms.has("tickets:assign")
      ? apiJson<UserBrief[]>("/api/v1/users").catch(() => [] as UserBrief[])
      : Promise.resolve([] as UserBrief[]),
  ]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 py-6">
        <nav className="mb-4 text-sm">
          <Link href="/tickets" className="text-brand-600 hover:underline">
            ← All tickets
          </Link>
        </nav>
        <TicketDetail
          ticket={ticket}
          initialComments={comments}
          me={{ id: me.id, email: me.email, name: me.name }}
          assignableUsers={users}
          can={{
            writeAny: perms.has("tickets:write:any"),
            writeOwn: perms.has("tickets:write:own"),
            assign: perms.has("tickets:assign"),
            deleteAny: perms.has("tickets:delete:any"),
            writeInternalComment: perms.has("ticket_comments:write:internal"),
          }}
        />
      </main>
    </>
  );
}
