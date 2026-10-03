import type { ReactNode } from "react";
import { NotificationsBackdrop } from "@/components/notifications-backdrop";

/**
 * Section shell for the Notification centre (/notifications). Adds no chrome of
 * its own — the page keeps its TopBar + <main> — and only mounts the fixed
 * ringing-bells backdrop once behind an `.fx-surface` wrapper, whose
 * card-translucency rules (globals.css) let the bells drift faintly behind the
 * notification list.
 */
export default function NotificationsLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <NotificationsBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
