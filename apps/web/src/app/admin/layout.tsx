import type { ReactNode } from "react";
import { AdminBackdrop } from "@/components/admin-backdrop";

/**
 * Section shell for Admin (everything under /admin). Adds no chrome of its own —
 * each page keeps its TopBar + <main> — and only mounts the fixed turning-gears
 * backdrop once behind an `.fx-surface` wrapper, whose card-translucency rules
 * (globals.css) let the cogs turn faintly behind the settings cards.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <AdminBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
