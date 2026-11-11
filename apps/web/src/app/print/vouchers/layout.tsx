import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";

/** The printable guest vouchers come from the UniFi controller, which is part of Monitoring. */
export default function PrintVouchersLayout({ children }: { children: ReactNode }) {
  return <RequireModule module="monitoring">{children}</RequireModule>;
}
