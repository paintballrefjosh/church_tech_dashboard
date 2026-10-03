import type { ReactNode } from "react";
import { HelpdeskBackdrop } from "@/components/helpdesk-backdrop";

/**
 * Section shell for the Help Desk (everything under /tickets). Like the
 * Monitoring shell it adds no chrome of its own — each page keeps its TopBar +
 * <main> — and only mounts the fixed conversation backdrop once behind an
 * `.fx-surface` wrapper, whose card-translucency rules (globals.css) let the
 * animation show faintly through the ticket cards.
 */
export default function TicketsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <HelpdeskBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
