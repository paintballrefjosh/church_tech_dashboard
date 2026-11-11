import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";

/** The printable UniFi port sheet reads Monitoring data. */
export default function PrintUnifiLayout({ children }: { children: ReactNode }) {
  return <RequireModule module="monitoring">{children}</RequireModule>;
}
