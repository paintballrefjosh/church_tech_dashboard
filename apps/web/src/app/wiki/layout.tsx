import type { ReactNode } from "react";
import { WikiBackdrop } from "@/components/wiki-backdrop";

/**
 * Section shell for the Wiki (everything under /wiki). Adds no chrome of its own
 * — each page keeps its TopBar + <main> — and only mounts the fixed
 * linked-pages backdrop once behind an `.fx-surface` wrapper, whose
 * card-translucency rules (globals.css) let the animation show faintly through
 * the page/sidebar cards. `fx-reading` adds a light wash behind the whole
 * content column so article text stays easy to read over the motion.
 */
export default function WikiLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <WikiBackdrop />
      <div className="fx-surface fx-reading">{children}</div>
    </div>
  );
}
