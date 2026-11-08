import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { ProPresenterBackdrop } from "@/components/propresenter-backdrop";
import { SignageTabs } from "./signage-ui";

export const dynamic = "force-dynamic";

/** Signage (the `signage` module, docs/signage.md). Every page of the module, its settings included, is under /signage.
 * Shares the drifting-slides backdrop with ProPresenter, so the header and cards match the other pages. */
export default async function SignageLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div>
      <ProPresenterBackdrop />
      <div className="fx-surface">
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-8">
          <SignageTabs />
          {children}
        </main>
      </div>
    </div>
  );
}
