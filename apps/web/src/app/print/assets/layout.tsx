import type { ReactNode } from "react";
import { RequireModule } from "@/components/require-module";

/** Equipment labels read the Assets module. */
export default function PrintAssetsLayout({ children }: { children: ReactNode }) {
  return <RequireModule module="assets">{children}</RequireModule>;
}
