import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { CabinetPrint } from "./cabinet-print";

export const dynamic = "force-dynamic";

/** The printable cabinet sheet. No top bar or footer: it is meant for paper, and `cabinet-print.tsx` draws all of it. */
export default async function CabinetPrintPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");
  return <CabinetPrint />;
}
