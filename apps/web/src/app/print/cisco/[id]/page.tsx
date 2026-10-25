import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PortSheetPrint } from "@/components/port-sheet-print";

export const dynamic = "force-dynamic";

/** The printable port sheet of a Cisco switch (picture, then every port with its VLAN and subnet). No navigation: it is for paper. */
export default async function CiscoPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { id } = await params;
  return <PortSheetPrint kind="cisco" deviceKey={id} backHref={`/monitoring/network-cisco/switches/${id}`} />;
}
