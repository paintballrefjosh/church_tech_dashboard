import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { Images } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";

export const dynamic = "force-dynamic";

/**
 * Device profiles: the front and back pictures and port layouts that draw Cisco switches, UniFi devices, infra hosts and
 * cabinet items. Part of the `monitoring` module, like Cabinets (reads monitors:read:any, writes monitors:write:any).
 */
export default async function DeviceProfilesLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <PageTitle icon={Images}>Device profiles</PageTitle>
        <div className="mt-6">{children}</div>
      </main>
    </>
  );
}
