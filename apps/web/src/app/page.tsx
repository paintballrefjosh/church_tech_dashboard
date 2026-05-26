import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { apiJson } from "@/lib/api";
import { TopBar } from "@/components/topbar";
import { DashboardGrid } from "./dashboard-tiles/dashboard-grid";
import { DEFAULT_DASHBOARD_LAYOUT, type TilePlacement } from "@church/shared";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  if ((session.user as { mustChangePassword?: boolean }).mustChangePassword) {
    redirect("/change-password");
  }

  const { layout } = await apiJson<{ layout: TilePlacement[] }>("/api/v1/dashboard/layout").catch(
    () => ({ layout: DEFAULT_DASHBOARD_LAYOUT }),
  );

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-7xl px-4 py-6">
        <DashboardGrid initialLayout={layout} />
      </main>
    </>
  );
}
