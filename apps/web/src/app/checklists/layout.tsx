import type { ReactNode } from "react";
import { ChecklistsBackdrop } from "@/components/checklists-backdrop";

/**
 * Section shell for Checklists (everything under /checklists). Adds no chrome of
 * its own — each page keeps its TopBar + <main> — and only mounts the fixed
 * ticking-checkbox backdrop once behind an `.fx-surface` wrapper, whose
 * card-translucency rules (globals.css) let the checkboxes drift faintly behind
 * the checklist cards.
 */
export default function ChecklistsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ChecklistsBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
