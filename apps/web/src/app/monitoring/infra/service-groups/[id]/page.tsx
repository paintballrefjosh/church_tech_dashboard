import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { ServiceGroupClient } from "./group-client";

export const dynamic = "force-dynamic";

/** One service group (docs/service-monitoring.md). */
export default async function ServiceGroupPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <ServiceGroupClient id={id} />
      </main>
    </>
  );
}
