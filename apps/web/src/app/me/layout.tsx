import type { ReactNode } from "react";
import { ProfileBackdrop } from "@/components/profile-backdrop";

/**
 * Section shell for My account (/me and its security and API token pages). Adds no chrome of its own: each page keeps its
 * TopBar + <main>. Mounts the avatar-badge backdrop once behind an `.fx-surface` wrapper, like the other sections.
 */
export default function MeLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ProfileBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
