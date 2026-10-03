"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Wiki backdrop: a slowly drifting web of knowledge pages — small document
 * glyphs (a header bar + text lines) joined by faint links as they pass near
 * each other, evoking cross-linked wiki articles. Teal/emerald, brighter in
 * dark mode. Built on the shared <CanvasBackdrop>.
 */

interface Doc {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number; // page width in px (height derived)
}

const LINK_DIST = 210; // px within which two pages draw a connecting link

function createKnowledge(): BackdropRenderer {
  let docs: Doc[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(20, Math.max(7, Math.floor((width * height) / 74000)));
      docs = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        w: Math.random() * 14 + 26, // 26..40 px wide
      }));
    },

    frame({ ctx, width, height, dark, reduceMotion, cursor }) {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = dark ? [45, 212, 191] : [13, 148, 136]; // teal-400 / 600
      const lineAlpha = dark ? 0.22 : 0.13;

      // Links first, so page glyphs sit on top of the threads.
      for (let i = 0; i < docs.length; i++) {
        const p = docs[i];
        if (!p) continue;
        if (!reduceMotion) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -30) p.x = width + 30;
          else if (p.x > width + 30) p.x = -30;
          if (p.y < -30) p.y = height + 30;
          else if (p.y > height + 30) p.y = -30;
        }
        for (let j = i + 1; j < docs.length; j++) {
          const q = docs[j];
          if (!q) continue;
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST * LINK_DIST) {
            const t = 1 - Math.sqrt(d2) / LINK_DIST;
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${t * lineAlpha})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
        if (cursor.active) {
          const dx = p.x - cursor.x;
          const dy = p.y - cursor.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST * LINK_DIST) {
            const t = 1 - Math.sqrt(d2) / LINK_DIST;
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${t * (lineAlpha + 0.12)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(cursor.x, cursor.y);
            ctx.stroke();
          }
        }
      }

      for (const d of docs) {
        drawPage(ctx, d.x, d.y, d.w, r, g, b, dark ? 0.2 : 0.15);
      }
    },
  };
}

/** A little portrait "page": faint body, a header bar, and three text lines. */
function drawPage(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  r: number,
  g: number,
  b: number,
  alpha: number,
) {
  const h = w * 1.3;
  const x = cx - w / 2;
  const y = cy - h / 2;
  const rr = w * 0.12;

  // Body.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.5})`;
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();

  // Header bar.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.6, alpha * 1.9)})`;
  ctx.fillRect(x + w * 0.16, y + h * 0.13, w * 0.68, h * 0.1);

  // Text lines.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.5, alpha * 1.4)})`;
  const lh = Math.max(1, h * 0.05);
  for (const [ly, lw] of [
    [0.36, 0.68],
    [0.5, 0.6],
    [0.64, 0.48],
  ] as const) {
    ctx.fillRect(x + w * 0.16, y + h * ly, w * lw, lh);
  }
}

export function WikiBackdrop() {
  return <CanvasBackdrop glow="wiki" createRenderer={createKnowledge} />;
}
