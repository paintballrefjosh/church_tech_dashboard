"use client";

import { useEffect, useRef, useState } from "react";
import { Maximize2, GripHorizontal, X } from "lucide-react";
import { Lightbox } from "@/components/lightbox";

export type MediaKind = "image" | "video";

/**
 * Inline media inside a note. Width is the source of truth; persisting it
 * happens in the parent (it rewrites the markdown so the new ?w= is part of
 * the saved body).
 *
 * Drag the bottom-right handle to resize. Click the maximize button to open
 * a full-screen lightbox. The image itself doesn't open the lightbox so
 * resizing isn't ambiguous with previewing.
 */
export function NoteMedia({
  url,
  kind,
  alt,
  width,
  onResizeEnd,
  onRemove,
  containerWidth,
}: {
  url: string;
  kind: MediaKind;
  alt: string;
  width: number | null;
  onResizeEnd: (newWidth: number) => void;
  onRemove: () => void;
  containerWidth: number;
}) {
  const [w, setW] = useState<number | null>(width);
  const [open, setOpen] = useState(false);
  const dragging = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => setW(width), [width]);

  function onPointerDown(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startW = w ?? Math.min(containerWidth, 320);
    dragging.current = { startX: e.clientX, startW };
    (e.target as Element).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const dx = e.clientX - dragging.current.startX;
    const next = Math.max(64, Math.min(containerWidth, dragging.current.startW + dx));
    setW(Math.round(next));
  }
  function onPointerUp(e: React.PointerEvent) {
    if (!dragging.current) return;
    (e.target as Element).releasePointerCapture(e.pointerId);
    const next = w ?? dragging.current.startW;
    dragging.current = null;
    if (next !== width) onResizeEnd(next);
  }

  const style = { width: w ? `${w}px` : "100%", maxWidth: "100%" };

  return (
    <>
      <figure
        className="group relative my-2 block"
        style={{ ...style, pointerEvents: "none" }}
      >
        {kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt={alt}
            className="block h-auto w-full rounded border border-slate-300 dark:border-slate-700"
            style={{ pointerEvents: "auto" }}
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        ) : (
          <video
            src={url}
            controls
            preload="metadata"
            className="block h-auto w-full rounded border border-slate-300 dark:border-slate-700"
            style={{ pointerEvents: "auto" }}
          />
        )}

        {/* enlarge — top-right. Always rendered so it's reachable from touch
            devices (no hover state) and from tests that hit it directly. */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setOpen(true);
          }}
          aria-label="Enlarge"
          title="Enlarge"
          style={{ pointerEvents: "auto" }}
          className="absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded bg-slate-900/60 text-white opacity-0 transition group-hover:opacity-100 hover:bg-slate-900 focus:opacity-100"
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden />
        </button>

        {/* remove — top-left */}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onRemove();
          }}
          aria-label="Remove attachment"
          title="Remove attachment"
          style={{ pointerEvents: "auto" }}
          className="absolute left-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded bg-slate-900/60 text-white opacity-0 transition group-hover:opacity-100 hover:bg-rose-600 focus:opacity-100"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>

        {/* resize handle — bottom-right */}
        <span
          role="slider"
          aria-label="Resize"
          aria-valuenow={w ?? 0}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          style={{ pointerEvents: "auto" }}
          className="absolute -bottom-1 -right-1 inline-flex h-5 w-5 cursor-se-resize items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 opacity-0 shadow transition group-hover:opacity-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
        >
          <GripHorizontal className="h-3 w-3 rotate-45" aria-hidden />
        </span>
      </figure>

      {open ? (
        <Lightbox onClose={() => setOpen(false)}>
          {kind === "image" ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={url} alt={alt} className="max-h-[90vh] max-w-[95vw] rounded shadow-2xl" />
          ) : (
            <video
              src={url}
              controls
              autoPlay
              className="max-h-[90vh] max-w-[95vw] rounded shadow-2xl"
            />
          )}
        </Lightbox>
      ) : null}
    </>
  );
}
