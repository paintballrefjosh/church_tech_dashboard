"use client";

import { useEffect, type ReactNode } from "react";
import { useModal } from "@/components/modal";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * Full-screen modal for previewing media. Mounts a portal under <body> so
 * it sits on top of every card / scroll container. Esc and backdrop click
 * dismiss.
 */
export function Lightbox({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  // Focus goes in and comes back, Tab stays inside, Escape closes (useModal).
  const dialogRef = useModal<HTMLDivElement>(onClose);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Media preview"
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/85 p-4"
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20"
      >
        <X className="h-5 w-5" aria-hidden />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full overflow-auto"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
