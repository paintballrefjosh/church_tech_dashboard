import type { ReactNode } from "react";
import { PlanningCenterBackdrop } from "@/components/planning-center-backdrop";

/**
 * Section shell for Planning Center (everything under /planning-center). Adds no
 * chrome of its own — each page keeps its TopBar + <main> — and only mounts the
 * fixed musical-notes backdrop once behind an `.fx-surface` wrapper, whose
 * card-translucency rules (globals.css) let the notes drift faintly behind the
 * service/plan cards.
 */
export default function PlanningCenterLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <PlanningCenterBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
