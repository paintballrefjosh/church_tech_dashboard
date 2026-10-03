"use client";

import { useEffect, useRef } from "react";

/**
 * Shared engine for the section backdrops (Monitoring / Help Desk / Printers).
 * It owns all the fiddly lifecycle — DPR-correct sizing, resize reseeding, a
 * rAF loop that pauses when the tab is hidden, a single static frame under
 * prefers-reduced-motion, passive cursor tracking, and theme (dark) read fresh
 * each frame so a toggle is picked up without re-mounting. A section supplies
 * only a {@link BackdropRenderer}: `seed` (re)builds state for the current size,
 * `frame` paints one tick. The wrapper is fixed, behind content, and
 * pointer-events:none (see .fx-backdrop / .fx-surface in globals.css).
 */
export interface BackdropFrame {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dark: boolean;
  reduceMotion: boolean;
  /** Live cursor in CSS px; `active` is false while off-window. */
  cursor: { x: number; y: number; active: boolean };
  /** Milliseconds since mount (0 for the reduced-motion static frame). */
  t: number;
}

export interface BackdropRenderer {
  seed(f: BackdropFrame): void;
  frame(f: BackdropFrame): void;
}

export function CanvasBackdrop({
  glow,
  createRenderer,
}: {
  glow:
    | "brand"
    | "helpdesk"
    | "print"
    | "wiki"
    | "notes"
    | "activity"
    | "pco"
    | "notifications"
    | "checklists"
    | "propresenter"
    | "admin";
  createRenderer: () => BackdropRenderer;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = createRenderer();
    const cursor = { x: -9999, y: -9999, active: false };
    const start = performance.now();
    let width = 0;
    let height = 0;
    let dpr = 1;

    const frameArg = (t: number): BackdropFrame => ({
      ctx,
      width,
      height,
      dark: document.documentElement.classList.contains("dark"),
      reduceMotion,
      cursor,
      t,
    });

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas!.width = Math.floor(width * dpr);
      canvas!.height = Math.floor(height * dpr);
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderer.seed(frameArg(reduceMotion ? 0 : performance.now() - start));
      if (reduceMotion) renderer.frame(frameArg(0));
    }

    let raf = 0;
    let running = true;
    function loop() {
      if (!running) return;
      renderer.frame(frameArg(performance.now() - start));
      raf = requestAnimationFrame(loop);
    }

    function onVisibility() {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
      } else if (!reduceMotion) {
        running = true;
        loop();
      }
    }
    function onPointerMove(e: PointerEvent) {
      cursor.x = e.clientX;
      cursor.y = e.clientY;
      cursor.active = true;
    }
    function onPointerLeave() {
      cursor.active = false;
    }

    // Under reduced motion the frame is static, so a theme toggle must repaint.
    const themeObserver = new MutationObserver(() => {
      if (reduceMotion) renderer.frame(frameArg(0));
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);

    if (!reduceMotion) loop();

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      themeObserver.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [createRenderer, glow]);

  return (
    <div className={`fx-backdrop fx-glow-${glow}`} aria-hidden>
      <canvas ref={canvasRef} />
    </div>
  );
}
