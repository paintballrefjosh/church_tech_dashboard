import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { TopBar } from "@/components/topbar";
import { ServiceInstanceClient } from "./service-instance-client";

export const dynamic = "force-dynamic";

/** One watched service on an infra host (docs/service-monitoring.md). */
export default async function ServiceInstancePage({ params }: { params: Promise<{ id: string; serviceId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id, serviceId } = await params;
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-6xl px-4 py-8">
        <ServiceInstanceClient targetId={id} id={serviceId} />
      </main>
    </>
  );
}
