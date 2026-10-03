import type { ReactNode } from "react";
import { ActivityBackdrop } from "@/components/activity-backdrop";

/**
 * Section shell for the Activity feed (/activity). Adds no chrome of its own —
 * the page keeps its TopBar + <main> — and only mounts the fixed event-pulse
 * backdrop once behind an `.fx-surface` wrapper, whose card-translucency rules
 * (globals.css) let the ripples show faintly through the feed cards.
 */
export default function ActivityLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ActivityBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
