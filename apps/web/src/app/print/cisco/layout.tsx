import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";

/** The printable Cisco port sheet reads Monitoring data. */
export default function PrintCiscoLayout({ children }: { children: ReactNode }) {
  return <RequireModule module="monitoring">{children}</RequireModule>;
}
