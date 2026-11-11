import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { RoomsBackdrop } from "@/components/rooms-backdrop";

export const dynamic = "force-dynamic";

/** Rooms (docs/assets.md): everyone signed in reads them; Equipment admins and site admins edit them. */
export default async function RoomsLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return (
    <div>
      <RoomsBackdrop />
      <div className="fx-surface">
        <TopBar />
        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
      </div>
    </div>
  );
}
