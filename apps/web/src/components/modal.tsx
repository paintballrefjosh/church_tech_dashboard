"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What a modal dialog owes a keyboard and screen-reader user, for the hand-built dialogs in the app: focus moves into it when
 * it opens, Tab and Shift+Tab stay inside, Escape closes it, and focus goes back to what opened it. Put the returned ref on the
 * dialog's panel (or its overlay) and give that element `role="dialog"`, `aria-modal="true"` and a name (`aria-label` or
 * `aria-labelledby`). A dialog that is only mounted while it is open can call this unconditionally.
 *
 * `onClose` may change on every render; the latest one is used. Pass `escape: false` while something inside needs the key
 * itself (a field mid-edit).
 */
export function useModal<T extends HTMLElement>(onClose: () => void, options: { escape?: boolean } = {}): RefObject<T | null> {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const escapeRef = useRef(options.escape ?? true);
  escapeRef.current = options.escape ?? true;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Focus the first thing to type in or press; if there is none, the panel itself.
    const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!node.contains(document.activeElement)) {
      const first = node.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ?? focusables()[0];
      if (first) first.focus();
      else {
        if (!node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
        node.focus();
      }
    }

    function onKey(e: KeyboardEvent) {
      if (!node) return;
      if (e.key === "Escape" && escapeRef.current) {
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!node.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Give focus back, unless the opener went away (a row that was deleted by the dialog).
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  return ref;
}

/**
 * A dialog frame (`DialogFrame`) for the hand-built dialogs: the dimmed overlay and the panel, with the behaviour of `useModal` and the
 * markup a screen reader needs. Clicking the dimmed area closes it (unless `closeOnBackdrop` is false). Mount it only while it
 * is open. `label` names the dialog; use `labelledBy` instead when the panel has a visible title with an id.
 *
 * It renders into `document.body`: the animated background gives cards a `backdrop-filter`, and an element with one becomes
 * the containing block of its `fixed` descendants, so a dialog opened from inside a card was dimmed and placed within that
 * card only, and the cards below it drew on top.
 */
export function DialogFrame({
  onClose,
  label,
  labelledBy,
  overlayClassName = "fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4",
  className,
  closeOnBackdrop = true,
  escape = true,
  testId,
  children,
}: {
  onClose: () => void;
  label?: string;
  labelledBy?: string;
  overlayClassName?: string;
  className?: string;
  closeOnBackdrop?: boolean;
  escape?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useModal<HTMLDivElement>(onClose, { escape });
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className={overlayClassName}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-label={labelledBy ? undefined : label} aria-labelledby={labelledBy} data-testid={testId} className={className}>
        {children}
      </div>
    </div>,
    document.body,
  );
}
