"use client";

import { useEffect, useRef, useState } from "react";

const MIN_WIDTH = 200;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 256; // matches the previous fixed 16rem column
const STORAGE_KEY = "wiki-sidebar-width";

/**
 * Wraps the wiki page tree in a user-resizable pane (drag the right edge, or
 * double-click it to reset) instead of a fixed 16rem column. Combined with
 * word-wrapped labels in WikiTreeSidebar, this lets a user with long page
 * titles widen the pane instead of losing text to truncation. Width is
 * per-browser (localStorage), not synced across devices. Only applies at
 * md+ — mobile always gets the full-width stacked layout.
 */
export function WikiSidebarPane({ children }: { children: React.ReactNode }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const widthRef = useRef(DEFAULT_WIDTH);
  const asideRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n)) {
        const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
        widthRef.current = clamped;
        setWidth(clamped);
      }
    } catch {
      // localStorage unavailable (private mode, etc.) — fall back to default.
    }
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!draggingRef.current || !asideRef.current) return;
      const rect = asideRef.current.getBoundingClientRect();
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(e.clientX - rect.left)));
      widthRef.current = next;
      setWidth(next);
    }
    function onUp() {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
      try {
        window.localStorage.setItem(STORAGE_KEY, String(widthRef.current));
      } catch {
        // ignore
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  function startDrag() {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  function resetWidth() {
    widthRef.current = DEFAULT_WIDTH;
    setWidth(DEFAULT_WIDTH);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  return (
    <aside
      ref={asideRef}
      style={{ ["--wiki-sidebar-w" as string]: `${width}px` }}
      // The resize handle is an absolutely-positioned child anchored to this
      // element's own right edge (not outside it) — overflow-y-auto below
      // otherwise computes overflow-x to auto too (CSS overflow spec: one
      // non-visible axis pulls the other off visible), which would clip a
      // handle sitting outside these bounds and swallow its pointer events.
      className="relative w-full shrink-0 pr-2 md:sticky md:top-4 md:max-h-[80vh] md:w-[var(--wiki-sidebar-w)] md:overflow-y-auto"
    >
      {children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize page tree"
        title="Drag to resize, double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={resetWidth}
        className="group absolute right-0 top-0 hidden h-full w-2 cursor-col-resize touch-none md:block"
      >
        <div className="mx-auto h-full w-px bg-slate-200 group-hover:bg-brand-400 dark:bg-slate-800" />
      </div>
    </aside>
  );
}
