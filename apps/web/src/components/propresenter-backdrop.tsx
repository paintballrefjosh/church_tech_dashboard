"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * ProPresenter backdrop: presentation slides drifting slowly across the page —
 * 16:9 cards with a title line and body lines, a few showing a live "play"
 * triangle as if being presented — for the worship slide-control screen.
 * Indigo/fuchsia, brighter in dark mode. Built on the shared <CanvasBackdrop>.
 */

interface Slide {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number; // 16:9, height derived
  live: boolean; // shows a play glyph
  seedv: number;
}

function createSlides(): BackdropRenderer {
  let slides: Slide[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(15, Math.max(6, Math.floor((width * height) / 100000)));
      slides = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.18,
        w: Math.random() * 46 + 64, // 64..110 px
        live: Math.random() < 0.3,
        seedv: Math.random(),
      }));
    },

    frame({ ctx, width, height, dark, reduceMotion }) {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = dark ? [129, 140, 248] : [79, 70, 229]; // indigo-400 / 600
      const bodyA = dark ? 0.16 : 0.11;

      for (const sl of slides) {
        if (!reduceMotion) {
          sl.x += sl.vx;
          sl.y += sl.vy;
          const m = sl.w + 30;
          if (sl.x < -m) sl.x = width + m;
          else if (sl.x > width + m) sl.x = -m;
          if (sl.y < -m) sl.y = height + m;
          else if (sl.y > height + m) sl.y = -m;
        }
        drawSlide(ctx, sl, r, g, b, bodyA);
      }
    },
  };
}

function drawSlide(ctx: CanvasRenderingContext2D, s: Slide, r: number, g: number, b: number, bodyA: number) {
  const w = s.w;
  const h = w * (9 / 16);
  const x = s.x - w / 2;
  const y = s.y - h / 2;
  const rr = w * 0.06;

  // Slide card + border.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${bodyA * 0.55})`;
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.5, bodyA * 2.2)})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (s.live) {
    // Being presented: a centered play triangle.
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.6, bodyA * 3)})`;
    const t = h * 0.26;
    const px = s.x - t * 0.35;
    ctx.beginPath();
    ctx.moveTo(px, s.y - t);
    ctx.lineTo(px, s.y + t);
    ctx.lineTo(px + t * 1.5, s.y);
    ctx.closePath();
    ctx.fill();
  } else {
    // Title line + a couple of body lines, roughly centered like a lyric slide.
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.6, bodyA * 2.8)})`;
    ctx.fillRect(x + w * 0.2, y + h * 0.26, w * 0.6, Math.max(1.4, h * 0.1));
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.4, bodyA * 1.7)})`;
    const lh = Math.max(1.2, h * 0.07);
    ctx.fillRect(x + w * 0.28, y + h * 0.52, w * 0.44, lh);
    ctx.fillRect(x + w * 0.33, y + h * 0.68, w * 0.34, lh);
  }
}

export function ProPresenterBackdrop() {
  return <CanvasBackdrop glow="propresenter" createRenderer={createSlides} />;
}
