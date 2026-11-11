import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";

/** The printable cabinet sheet reads Monitoring data. */
export default function CabinetPrintLayout({ children }: { children: ReactNode }) {
  return <RequireModule module="monitoring">{children}</RequireModule>;
}
