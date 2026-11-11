import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { RequireModule } from "@/components/require-module";
import { AssetsBackdrop } from "@/components/assets-backdrop";

export const dynamic = "force-dynamic";

/** Equipment (the `assets` module, docs/assets.md). Each page draws its own title. */
export default async function AssetsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <RequireModule module="assets">
      <div>
        <AssetsBackdrop />
        <div className="fx-surface">
          <TopBar />
          <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
        </div>
      </div>
    </RequireModule>
  );
}
