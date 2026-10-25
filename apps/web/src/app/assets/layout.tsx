import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";

export const dynamic = "force-dynamic";

/** Equipment (the `assets` module, docs/assets.md). Each page draws its own title. */
export default async function AssetsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </>
  );
}
