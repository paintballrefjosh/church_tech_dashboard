"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Gap between the pointer and the card, and the least room kept from the window's edges, in px. */
const OFFSET = 16;
const EDGE = 8;
const CARD_MAX_WIDTH = 560;

/**
 * A card that follows the mouse while it is over one of a list's rows (or cards). Mouse only: touch and the keyboard open
 * the thing's own page, which shows the same and more. `render` gives the card's content for the item under the pointer,
 * or null for no card at all (nothing worth showing). `onEnter` runs when the pointer arrives on an item (to start a read).
 * The card is hidden from screen readers and never takes the pointer.
 */
export function useFollowCard<T>({
  keyOf,
  render,
  onEnter,
  testId,
}: {
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode | null;
  onEnter?: (item: T) => void;
  testId: string;
}) {
  const [hover, setHover] = useState<{ item: T; x: number; y: number } | null>(null);
  const frame = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const bind = useCallback(
    (item: T) => {
      const key = keyOf(item);
      return {
        onPointerEnter: (e: ReactPointerEvent) => {
          if (e.pointerType !== "mouse") return;
          onEnter?.(item);
          setHover({ item, x: e.clientX, y: e.clientY });
        },
        onPointerMove: (e: ReactPointerEvent) => {
          if (e.pointerType !== "mouse") return;
          const { clientX: x, clientY: y } = e;
          // One position per frame, however fast the pointer moves.
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => {
            frame.current = null;
            setHover((h) => (h && keyOf(h.item) === key ? { ...h, x, y } : { item, x, y }));
          });
        },
        onPointerLeave: () => {
          if (frame.current !== null) cancelAnimationFrame(frame.current);
          frame.current = null;
          setHover((h) => (h && keyOf(h.item) === key ? null : h));
        },
      };
    },
    [keyOf, onEnter],
  );

  const content = hover ? render(hover.item) : null;
  const card = hover && content ? <FollowCard x={hover.x} y={hover.y} testId={testId}>{content}</FollowCard> : null;
  return { bind, card };
}

function FollowCard({ x, y, testId, children }: { x: number; y: number; testId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // Beside the pointer, flipped to the other side when it would leave the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = x + OFFSET;
    let top = y + OFFSET;
    if (left + width > window.innerWidth - EDGE) left = Math.max(EDGE, x - OFFSET - width);
    if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, y - OFFSET - height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      data-testid={testId}
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-md border border-slate-300 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      style={{ left: 0, top: 0, visibility: "hidden", width: `min(${CARD_MAX_WIDTH}px, calc(100vw - ${EDGE * 2}px))` }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The card's top line: the device's name, and the profile drawing it. */
export function FollowCardHeader({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5 text-xs">
      <span className="font-semibold text-slate-800 dark:text-slate-100">{name}</span>
      <span className="truncate text-slate-500 dark:text-slate-400">{detail}</span>
    </div>
  );
}

/** The card's bottom line. */
export function FollowCardNote({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 px-0.5 text-xs text-slate-600 dark:text-slate-400">{children}</p>;
}

/** A profile's plain picture (no ports to colour), at its own proportions. */
export function FollowCardPicture({ url, width, height }: { url: string; width: number; height: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the admin's own picture, served by the API
    <img src={url} width={width} height={height} alt="" className="h-auto max-h-64 w-full rounded object-contain" draggable={false} />
  );
}
