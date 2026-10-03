"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Monitoring backdrop: a drifting "constellation" network graph — points joined
 * by lines that brighten as they near each other and reach toward the cursor,
 * the node-graph motif of infra/crypto dashboards. Brand periwinkle, brighter in
 * dark mode against the near-black body. Built on the shared <CanvasBackdrop>.
 */

interface Point {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

const LINK_DIST = 150; // px within which two points draw a connecting line
const CURSOR_DIST = 190; // px within which points connect to the cursor

function createConstellation(): BackdropRenderer {
  let points: Point[] = [];

  return {
    seed({ width, height }) {
      // ~1 point per 15k px², capped so big displays stay cheap.
      const count = Math.min(130, Math.max(28, Math.floor((width * height) / 15000)));
      points = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.35,
        vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.4 + 0.8,
      }));
    },

    frame({ ctx, width, height, dark, reduceMotion, cursor }) {
      ctx.clearRect(0, 0, width, height);
      const [pr, pg, pb] = dark ? [129, 141, 225] : [69, 84, 193]; // brand-400 / 600
      const [lr, lg, lb] = [91, 107, 214]; // brand-500
      const lineAlpha = dark ? 0.26 : 0.15;

      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (!p) continue;
        if (!reduceMotion) {
          p.x += p.vx;
          p.y += p.vy;
          if (p.x < -20) p.x = width + 20;
          else if (p.x > width + 20) p.x = -20;
          if (p.y < -20) p.y = height + 20;
          else if (p.y > height + 20) p.y = -20;
        }

        for (let j = i + 1; j < points.length; j++) {
          const q = points[j];
          if (!q) continue;
          const dx = p.x - q.x;
          const dy = p.y - q.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK_DIST * LINK_DIST) {
            const t = 1 - Math.sqrt(d2) / LINK_DIST;
            ctx.strokeStyle = `rgba(${lr}, ${lg}, ${lb}, ${t * lineAlpha})`;
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
          if (d2 < CURSOR_DIST * CURSOR_DIST) {
            const t = 1 - Math.sqrt(d2) / CURSOR_DIST;
            ctx.strokeStyle = `rgba(${lr}, ${lg}, ${lb}, ${t * (lineAlpha + 0.15)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(cursor.x, cursor.y);
            ctx.stroke();
          }
        }

        ctx.fillStyle = `rgba(${pr}, ${pg}, ${pb}, 0.6)`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };
}

export function MonitoringBackdrop() {
  return <CanvasBackdrop glow="brand" createRenderer={createConstellation} />;
}
