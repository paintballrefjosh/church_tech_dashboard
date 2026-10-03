"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

/**
 * Renders a ```mermaid fenced block as an SVG diagram. Client-only: mermaid
 * needs the DOM and is large, so it is dynamically imported on first use and
 * never lands in the bundle of pages without a diagram. `securityLevel:
 * "strict"` makes mermaid sanitise labels, so wiki authors cannot inject
 * HTML/script through a diagram. A diagram that fails to parse falls back to
 * showing its source with the error, so a typo never blanks the page.
 */
export function MermaidDiagram({ chart }: { chart: string }) {
  const { resolvedTheme } = useTheme();
  const reactId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        // Mermaid uses the id as a DOM id; useId() output contains colons.
        const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9]/g, "")}`;
        const out = await mermaid.render(id, chart.trim());
        if (!cancelled) {
          setSvg(out.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chart, resolvedTheme, reactId]);

  if (error) {
    return (
      <div className="not-prose my-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm dark:border-red-900 dark:bg-red-950/40">
        <p className="font-medium text-red-700 dark:text-red-300">Diagram could not be rendered</p>
        <p className="mt-1 text-red-700/80 dark:text-red-300/80">{error}</p>
        <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">{chart}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="not-prose my-4 h-40 animate-pulse rounded-md border border-slate-200 bg-slate-100 dark:border-slate-800 dark:bg-slate-900" />
    );
  }
  return (
    <div
      className="not-prose my-4 overflow-x-auto rounded-md border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      role="img"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
