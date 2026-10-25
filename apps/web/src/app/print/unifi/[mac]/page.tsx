import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PortSheetPrint } from "@/components/port-sheet-print";

export const dynamic = "force-dynamic";

/** The printable port sheet of a UniFi switch or gateway, by MAC. No navigation: it is for paper. */
export default async function UnifiPrintPage({ params }: { params: Promise<{ mac: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  const { mac } = await params;
  return <PortSheetPrint kind="unifi" deviceKey={decodeURIComponent(mac)} backHref="/monitoring/network" />;
}
