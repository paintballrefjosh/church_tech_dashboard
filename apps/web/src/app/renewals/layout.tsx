import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { PageTitle } from "@/components/page-title";
import { RequireModule } from "@/components/require-module";
import { RenewalsBackdrop } from "@/components/renewals-backdrop";

export const dynamic = "force-dynamic";

/** Renewals: licences, domains, warranties and subscriptions, with reminders. Part of the `monitoring` module, like Cabinets. */
export default async function RenewalsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <RequireModule module="monitoring">
      <div>
        <RenewalsBackdrop />
        <div className="fx-surface">
          <TopBar />
          <main className="mx-auto max-w-6xl px-4 py-8">
            <PageTitle icon={CalendarClock}>Renewals</PageTitle>
            <div className="mt-6">{children}</div>
          </main>
        </div>
      </div>
    </RequireModule>
  );
}
