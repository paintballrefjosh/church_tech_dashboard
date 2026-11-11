"use client";

import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

/**
 * A short explanation that appears when the pointer rests on a control or the control has keyboard focus.
 *
 * Wrap exactly one control. The tip is wired to it with `aria-describedby` (a screen reader reads it after the control's
 * name) and Escape hides it without moving focus. Rules this follows:
 *  - It is drawn in a portal on `document.body` with `position: fixed`, never inside the page's cards: the animated
 *    background gives each card a `backdrop-filter`, which makes the card its own stacking context, so a tip drawn inside
 *    one went BEHIND the next card (and a `fixed` child of such a card is trapped inside it). See CLAUDE.md, Accessibility (4).
 *  - It opens BELOW the control and flips ABOVE it when there is not room underneath (the viewport is measured, so it
 *    works wherever the page is scrolled), then is kept inside the window sideways. It follows scrolling and resizing.
 *  - The wrapper takes the hover, not the control, so a DISABLED button (which gets no mouse events) still explains itself;
 *    the pointer can move onto the tip (it closes shortly after both are left), so a link inside it can be pressed.
 *  - A link in the tip (`TipLink`) is for the mouse: the portal puts it outside the control's tab order, so anything a
 *    keyboard user needs must also be reachable another way (the guide is a tab of its own).
 *
 * Keep the text to a few sentences: what the control does, what it leaves alone, and anything that surprises.
 */
const MARGIN = 8;
const CLOSE_DELAY_MS = 120;

export function HoverTip({ tip, children }: { tip: ReactNode; children: ReactElement<{ "aria-describedby"?: string }> }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const open = (hover || focus) && !dismissed;

  const place = useCallback(() => {
    const a = anchor.current;
    const b = box.current;
    if (!a || !b) return;
    const r = a.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const w = b.offsetWidth;
    const h = b.offsetHeight;
    const roomBelow = vh - r.bottom - MARGIN;
    const roomAbove = r.top - MARGIN;
    // Below unless it does not fit there and there is more room above.
    const above = h > roomBelow && roomAbove > roomBelow;
    const maxHeight = Math.max(120, above ? roomAbove : roomBelow);
    const used = Math.min(h, maxHeight);
    const top = above ? r.top - used : r.bottom;
    const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, vw - w - MARGIN));
    setPos((p) => (p && p.left === left && p.top === top && p.maxHeight === maxHeight ? p : { left, top, maxHeight }));
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
  }, [open, place, tip]);

  useEffect(() => {
    if (!open) return;
    const again = () => place();
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    return () => {
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
    };
  }, [open, place]);

  useEffect(() => {
    if (!hover && !focus) setDismissed(false);
  }, [hover, focus]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const enter = () => {
    if (timer.current) clearTimeout(timer.current);
    setHover(true);
  };
  const leave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHover(false), CLOSE_DELAY_MS);
  };

  return (
    <span
      ref={anchor}
      className="inline-flex"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) setDismissed(true);
      }}
    >
      {cloneElement(children, { "aria-describedby": id })}
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              ref={box}
              id={id}
              role="tooltip"
              onMouseEnter={enter}
              onMouseLeave={leave}
              style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, maxHeight: pos?.maxHeight, visibility: pos ? "visible" : "hidden" }}
              className="z-[60] block w-72 max-w-[calc(100vw-1rem)] overflow-y-auto py-1.5 text-left"
            >
              {/* The padding above and below belongs to the tip's box, so the pointer can travel from the control onto the tip without it closing. */}
              <span className="block rounded-md border border-slate-700 bg-slate-900 p-3 text-xs font-normal leading-relaxed text-slate-50 shadow-lg dark:border-slate-300 dark:bg-slate-100 dark:text-slate-900">{tip}</span>
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

/** A link inside a tip, coloured for the tip's own background (dark in light mode, light in dark mode). */
export function TipLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-brand-300 underline hover:no-underline dark:text-brand-700">
      {children}
    </Link>
  );
}
