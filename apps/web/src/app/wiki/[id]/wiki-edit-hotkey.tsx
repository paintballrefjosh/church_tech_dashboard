"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";

/**
 * View-mode "e" hotkey: pressing e pops a small tooltip at the cursor with
 * Edit / Cancel so a keyboard-first user can jump into edit mode without
 * hunting for the toolbar button. Ignored while focus is in a form field
 * (so typing "e" in, say, the attachments rename input isn't hijacked) or
 * while a modifier key is held.
 */
export function WikiEditHotkey({ pageId, canEdit }: { pageId: string; canEdit: boolean }) {
  const router = useRouter();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const popupRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      mouseRef.current = { x: e.clientX, y: e.clientY };
    }
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    if (!canEdit) return;
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== "e") return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      setPos({ x: mouseRef.current.x, y: mouseRef.current.y });
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canEdit]);

  useEffect(() => {
    if (!pos) return;
    function onClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setPos(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setPos(null);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [pos]);

  if (!canEdit || !pos) return null;

  // Clamp so the popup stays on-screen when e is pressed near an edge.
  const left = Math.min(pos.x, window.innerWidth - 176);
  const top = Math.min(pos.y, window.innerHeight - 96);

  return (
    <div
      ref={popupRef}
      role="dialog"
      aria-label="Edit this page?"
      className="fixed z-50 w-44 rounded-md border border-slate-300 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900"
      style={{ left, top }}
    >
      <p className="mb-2 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
        <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit this page?
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          autoFocus
          onClick={() => router.push(`/wiki/${pageId}/edit`)}
          className="rounded-md bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={() => setPos(null)}
          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
