"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * "Skip to content": the first stop for the Tab key, so a keyboard or screen-reader user does not have to go through the whole
 * top bar on every page. Each page has its own `<main>` (there is no shared id), so it moves focus to the first one.
 */
export function SkipLink() {
  const pathname = usePathname();
  // Give the first <main> an id so the link has a target even before it is clicked (and without JavaScript's help afterwards).
  useEffect(() => {
    const main = document.querySelector("main");
    if (main && !main.id) main.id = "main";
  }, [pathname]);
  return (
    <a
      href="#main"
      onClick={(e) => {
        const main = document.querySelector("main");
        if (!main) return;
        e.preventDefault();
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
        main.scrollIntoView();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-md focus:bg-brand-700 focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-white"
    >
      Skip to content
    </a>
  );
}
