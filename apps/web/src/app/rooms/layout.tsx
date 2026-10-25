import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";

export const dynamic = "force-dynamic";

/** Rooms (docs/assets.md): everyone signed in reads them; Equipment admins and site admins edit them. */
export default async function RoomsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </>
  );
}
