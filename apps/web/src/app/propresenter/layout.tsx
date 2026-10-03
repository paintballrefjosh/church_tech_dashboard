import type { ReactNode } from "react";
import { ProPresenterBackdrop } from "@/components/propresenter-backdrop";

/**
 * Section shell for ProPresenter (/propresenter). Adds no chrome of its own —
 * the page keeps its TopBar + <main> — and only mounts the fixed drifting-slides
 * backdrop once behind an `.fx-surface` wrapper, whose card-translucency rules
 * (globals.css) let the slides drift faintly behind the control cards.
 */
export default function ProPresenterLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <ProPresenterBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
