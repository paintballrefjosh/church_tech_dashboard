import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { Bell } from "lucide-react";
import type { Notification } from "@church/shared";
import { NotificationsPanel } from "./notifications-panel";

export const dynamic = "force-dynamic";

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ unread?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }
  const params = await searchParams;
  const unread = params.unread === "true";
  const items = await apiJson<Notification[]>(
    `/api/v1/notifications?limit=100${unread ? "&unread=true" : ""}`,
  ).catch(() => [] as Notification[]);

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-6">
        <PageTitle icon={Bell}>Notifications</PageTitle>
        <NotificationsPanel initial={items} initialUnreadOnly={unread} />
      </main>
    </>
  );
}
