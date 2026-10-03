import type { ReactNode } from "react";
import { PrintersBackdrop } from "@/components/printers-backdrop";

/**
 * Section shell for Printers (/printers). Adds no chrome of its own — the page
 * keeps its TopBar + <main> — and only mounts the fixed CMYK-halftone backdrop
 * once behind an `.fx-surface` wrapper, whose card-translucency rules
 * (globals.css) let the raster ripple faintly through the printer cards.
 */
export default function PrintersLayout({ children }: { children: ReactNode }) {
  return (
    <div>
      <PrintersBackdrop />
      <div className="fx-surface">{children}</div>
    </div>
  );
}
