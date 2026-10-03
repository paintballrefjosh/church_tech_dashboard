import type { ReactNode } from "react";
import { MonitoringBackdrop } from "@/components/monitoring-backdrop";

/**
 * Section shell for everything under /monitoring. It contributes no chrome of
 * its own (each page/nested layout still renders its own TopBar + <main>); it
 * only mounts the fixed constellation backdrop once for the whole section and
 * wraps the routed content in `.fx-surface`, whose stacking + card translucency
 * rules (globals.css) let that backdrop show through the cards.
 */
export default function MonitoringLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <MonitoringBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
