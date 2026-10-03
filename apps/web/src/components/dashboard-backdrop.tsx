"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Dashboard home backdrop: the modular tiles themselves, set adrift — small
 * widget glyphs (mini bar chart, sparkline, stat block, list) with a header
 * bar, floating slowly across the page. Brand periwinkle, the app's primary
 * identity, brighter in dark mode. Built on the shared <CanvasBackdrop>.
 *
 * NB: the home page is the root route, so there's no place for a section
 * layout.tsx (that would wrap the whole app) — this mounts directly in page.tsx.
 */

type Kind = 0 | 1 | 2 | 3; // bars | sparkline | list | stat

interface Tile {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  kind: Kind;
  seedv: number; // stable per-tile randomness for inner detail
}

const ASPECT: Record<Kind, number> = { 0: 0.72, 1: 0.6, 2: 0.8, 3: 0.62 };

function createWidgets(): BackdropRenderer {
  let tiles: Tile[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(16, Math.max(6, Math.floor((width * height) / 95000)));
      tiles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.2,
        vy: (Math.random() - 0.5) * 0.2,
        w: Math.random() * 42 + 54, // 54..96 px
        kind: Math.floor(Math.random() * 4) as Kind,
        seedv: Math.random(),
      }));
    },

    frame({ ctx, width, height, dark, reduceMotion }) {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = dark ? [129, 141, 225] : [79, 93, 201]; // brand-400 / ~600
      const bodyA = dark ? 0.16 : 0.11;

      for (const tsq of tiles) {
        if (!reduceMotion) {
          tsq.x += tsq.vx;
          tsq.y += tsq.vy;
          const m = tsq.w + 30;
          if (tsq.x < -m) tsq.x = width + m;
          else if (tsq.x > width + m) tsq.x = -m;
          if (tsq.y < -m) tsq.y = height + m;
          else if (tsq.y > height + m) tsq.y = -m;
        }
        drawTile(ctx, tsq, r, g, b, bodyA);
      }
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  t: Tile,
  r: number,
  g: number,
  b: number,
  bodyA: number,
) {
  const w = t.w;
  const h = w * ASPECT[t.kind];
  const x = t.x - w / 2;
  const y = t.y - h / 2;

  // Body + border.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${bodyA * 0.55})`;
  roundRect(ctx, x, y, w, h, w * 0.1);
  ctx.fill();
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.5, bodyA * 2.2)})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  const ink = `rgba(${r}, ${g}, ${b}, ${Math.min(0.55, bodyA * 2.6)})`;
  const dim = `rgba(${r}, ${g}, ${b}, ${Math.min(0.4, bodyA * 1.7)})`;

  // Header bar (all kinds).
  ctx.fillStyle = dim;
  ctx.fillRect(x + w * 0.12, y + h * 0.14, w * 0.5, Math.max(1.2, h * 0.08));

  const px = x + w * 0.12; // inner left
  const pr = x + w * 0.88; // inner right
  const pw = pr - px;
  const baseY = y + h * 0.8; // chart baseline

  ctx.fillStyle = ink;
  ctx.strokeStyle = ink;

  if (t.kind === 0) {
    // Bar chart: 4 bars of pseudo-random heights.
    const bars = 4;
    const bw = pw / (bars * 1.7);
    for (let i = 0; i < bars; i++) {
      const frac = 0.35 + 0.6 * Math.abs(Math.sin(t.seedv * 9 + i * 1.3));
      const bh = (h * 0.5) * frac;
      ctx.fillRect(px + i * bw * 1.7, baseY - bh, bw, bh);
    }
  } else if (t.kind === 1) {
    // Sparkline.
    ctx.lineWidth = Math.max(1, h * 0.04);
    ctx.lineJoin = "round";
    ctx.beginPath();
    const pts = 6;
    for (let i = 0; i < pts; i++) {
      const fx = px + (pw * i) / (pts - 1);
      const fy = y + h * 0.42 + Math.sin(t.seedv * 7 + i * 1.1) * h * 0.22;
      if (i === 0) ctx.moveTo(fx, fy);
      else ctx.lineTo(fx, fy);
    }
    ctx.stroke();
  } else if (t.kind === 2) {
    // List rows.
    const lh = Math.max(1.2, h * 0.07);
    for (const [ly, lw] of [
      [0.42, 0.76],
      [0.58, 0.64],
      [0.74, 0.52],
    ] as const) {
      ctx.fillRect(px, y + h * ly, pw * lw, lh);
    }
  } else {
    // Big stat: a large value block + a small unit label.
    ctx.fillRect(px, y + h * 0.4, pw * 0.5, h * 0.3);
    ctx.fillStyle = dim;
    ctx.fillRect(px, y + h * 0.78, pw * 0.34, Math.max(1.2, h * 0.07));
  }
}

export function DashboardBackdrop() {
  return <CanvasBackdrop glow="brand" createRenderer={createWidgets} />;
}
