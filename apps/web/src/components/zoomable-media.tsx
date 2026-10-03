"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize2 } from "lucide-react";
import { Lightbox } from "@/components/lightbox";

const FRAME = "rounded-md border border-slate-300 dark:border-slate-800";

/** Wrapper classes: with an explicit `?w=` width the wrapper owns the sizing,
 *  otherwise it shrink-wraps the media and is capped at the column width. */
function wrapperClass(style: CSSProperties | undefined): string {
  return `relative ${style ? "block" : "inline-block max-w-full"}`;
}

const ENLARGE_BUTTON =
  "absolute right-2 top-2 z-10 inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-900/60 text-white shadow transition hover:bg-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-white";

/** Re-run `measure` whenever the element's rendered size changes. */
function useResizeMeasure(ref: React.RefObject<HTMLElement | null>, measure: () => void) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure(); // covers media that finished loading before hydration
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, measure]);
}

/**
 * Image shown in a wiki page body. When it is rendered smaller than its
 * natural size it becomes clickable (and gets an enlarge button for touch /
 * keyboard users) and opens in the shared Lightbox. An image that already
 * fits at full size stays a plain image.
 */
export function ZoomableImage({
  src,
  alt,
  style,
}: {
  src: string;
  alt: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLImageElement>(null);
  const [scaled, setScaled] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || !el.complete || el.naturalWidth === 0) return;
    setScaled(el.naturalWidth > el.clientWidth + 1);
  }, []);
  useResizeMeasure(ref, measure);

  return (
    <>
      <span className={wrapperClass(style)} style={style}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={ref}
          src={src}
          alt={alt}
          loading="lazy"
          onLoad={measure}
          onClick={scaled ? () => setOpen(true) : undefined}
          onKeyDown={
            scaled
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setOpen(true);
                  }
                }
              : undefined
          }
          role={scaled ? "button" : undefined}
          tabIndex={scaled ? 0 : undefined}
          title={scaled ? "View full size" : undefined}
          className={`block h-auto ${style ? "w-full" : "max-w-full"} ${FRAME} ${
            scaled ? "cursor-zoom-in" : ""
          }`}
        />
        {scaled ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="View full size"
            title="View full size"
            className={ENLARGE_BUTTON}
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </span>
      {open ? (
        <Lightbox onClose={() => setOpen(false)}>
          <FullSizeImage src={src} alt={alt} />
        </Lightbox>
      ) : null}
    </>
  );
}

/**
 * Lightbox contents for an image. Opens fitted to the viewport; if the image
 * is bigger than the viewport, clicking it toggles between fitted and actual
 * pixel size (the Lightbox scrolls when it overflows).
 */
function FullSizeImage({ src, alt }: { src: string; alt: string }) {
  const [actual, setActual] = useState(false);
  const [canToggle, setCanToggle] = useState(false);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      onLoad={(e) => {
        const img = e.currentTarget;
        setCanToggle(
          img.naturalWidth > window.innerWidth * 0.95 || img.naturalHeight > window.innerHeight * 0.9,
        );
      }}
      onClick={canToggle ? () => setActual((a) => !a) : undefined}
      title={canToggle ? (actual ? "Fit to screen" : "Actual size") : undefined}
      className={
        actual
          ? "max-h-none max-w-none cursor-zoom-out rounded shadow-2xl"
          : `max-h-[90vh] max-w-[95vw] rounded shadow-2xl ${canToggle ? "cursor-zoom-in" : ""}`
      }
    />
  );
}

/**
 * Video shown in a wiki page body. When it is rendered smaller than its
 * native resolution an enlarge button appears; it pauses the inline player
 * and opens the video in the shared Lightbox.
 */
export function ZoomableVideo({ src, style }: { src: string; style?: CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [scaled, setScaled] = useState(false);
  const [open, setOpen] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el || el.videoWidth === 0) return;
    setScaled(el.videoWidth > el.clientWidth + 1);
  }, []);
  useResizeMeasure(ref, measure);

  return (
    <>
      <span className={wrapperClass(style)} style={style}>
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          ref={ref}
          src={src}
          controls
          preload="metadata"
          onLoadedMetadata={measure}
          className={`block h-auto ${style ? "w-full" : "max-w-full"} ${FRAME}`}
        />
        {scaled ? (
          <button
            type="button"
            onClick={() => {
              ref.current?.pause();
              setOpen(true);
            }}
            aria-label="View full size"
            title="View full size"
            className={ENLARGE_BUTTON}
          >
            <Maximize2 className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </span>
      {open ? (
        <Lightbox onClose={() => setOpen(false)}>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={src}
            controls
            autoPlay
            className="max-h-[90vh] max-w-[95vw] rounded shadow-2xl"
          />
        </Lightbox>
      ) : null}
    </>
  );
}
