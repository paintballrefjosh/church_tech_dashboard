import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { DashboardBackdrop } from "@/components/dashboard-backdrop";
import { DashboardGrid } from "./dashboard-tiles/dashboard-grid";
import {
  DEFAULT_DASHBOARD_LAYOUT,
  type Note,
  type Ticket,
  type TilePlacement,
  type WikiPage,
} from "@church/shared";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }

  // Resolve who this is BEFORE fetching any module data. A pending (awaiting
  // approval) account goes to /pending; an account with no module access at
  // all gets a "no access yet" message instead of an empty dashboard shell.
  // /me is read fresh from the DB so this is correct even on the very first
  // sign-in (before the session JWT reflects the provisioning decision).
  const me = await apiJson<{
    access: Record<string, "user" | "moderator" | "admin">;
    approvalStatus?: "approved" | "pending";
  }>("/api/v1/me").catch(() => null);

  if (me?.approvalStatus === "pending") redirect("/pending");

  const access = me?.access ?? {};
  if (Object.keys(access).length === 0) {
    return (
      <>
        <TopBar />
        <DashboardBackdrop />
        <main className="fx-surface mx-auto max-w-2xl px-4 py-16">
          <div className="rounded-lg border border-slate-300 bg-white p-8 text-center dark:border-slate-800 dark:bg-slate-900">
            <h1 className="text-lg font-semibold">No access yet</h1>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
              Your account doesn&apos;t have access to any modules yet. If you just signed in for
              the first time, an administrator needs to grant you access before you can use the
              dashboard. Please check back later.
            </p>
          </div>
        </main>
      </>
    );
  }

  // Pre-fetch the rarely-refreshed tile data alongside the layout so the
  // dashboard renders fully-populated on first paint — no per-tile
  // "Loading…" flash after hydration. The monitor / Planning Center tiles
  // keep their own client-side polling because their data changes second by
  // second; the slow-moving ones (tickets / notes / wiki) get static initial
  // payloads here.
  const [{ layout }, tickets, notes, wikiPages] = await Promise.all([
    apiJson<{ layout: TilePlacement[] }>("/api/v1/dashboard/layout").catch(() => ({
      layout: DEFAULT_DASHBOARD_LAYOUT,
    })),
    apiJson<Ticket[]>("/api/v1/tickets?scope=own&limit=20").catch(() => [] as Ticket[]),
    apiJson<Note[]>("/api/v1/notes").catch(() => [] as Note[]),
    apiJson<WikiPage[]>("/api/v1/wiki").catch(() => [] as WikiPage[]),
  ]);

  return (
    <>
      <TopBar />
      <DashboardBackdrop />
      <main className="fx-surface mx-auto max-w-6xl px-4 py-6">
        <DashboardGrid
          initialLayout={layout}
          access={access}
          initialData={{ tickets, notes, wikiPages }}
        />
      </main>
    </>
  );
}
