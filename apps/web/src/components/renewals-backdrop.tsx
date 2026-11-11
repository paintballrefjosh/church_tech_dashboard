"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Renewals backdrop: tear-off calendar pages drifting upward, each with a coloured header strip, two binder rings and a grid
 * of days, one of them circled and gently pulsing: the date something lapses. Amber / rose / indigo hues. Deterministic
 * time-based tracks, so it survives resize and the reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Page {
  baseX: number;
  size: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  tilt: number;
  color: number;
  alpha: number;
  circled: number; // 0..19
}

const PALETTE: Array<[number, number, number]> = [
  [245, 158, 11], // amber
  [244, 63, 94], // rose
  [99, 102, 241], // indigo
  [20, 184, 166], // teal
];

function createPages(): BackdropRenderer {
  let pages: Page[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(18, Math.max(7, Math.floor((width * height) / 70000)));
      pages = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 22 + 40,
        speed: Math.random() * 10 + 6,
        offset: Math.random(),
        swayAmp: Math.random() * 8 + 4,
        swayFreq: Math.random() * 0.3 + 0.2,
        phase: Math.random() * Math.PI * 2,
        tilt: (Math.random() - 0.5) * 0.35,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.06 + 0.14,
        circled: Math.floor(Math.random() * 20),
      }));
    },
    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const ink = dark ? "226, 232, 240" : "51, 65, 85";
      for (const p of pages) {
        const s = p.size;
        const travel = height + s * 2;
        const prog = ((p.speed * secs + p.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = p.baseX * width + Math.sin(secs * p.swayFreq + p.phase) * p.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = p.alpha * edge;
        if (a <= 0.004) continue;
        const col = PALETTE[p.color];
        if (!col) continue;
        const [r, g, b] = col;
        const half = s / 2;
        const head = s * 0.22;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(p.tilt);
        // Page body and the header strip.
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.55})`;
        ctx.beginPath();
        ctx.roundRect(-half, -half, s, s, 4);
        ctx.fill();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 1.3})`;
        ctx.beginPath();
        ctx.roundRect(-half, -half, s, head, [4, 4, 0, 0]);
        ctx.fill();
        // Binder rings.
        ctx.fillStyle = `rgba(${ink}, ${Math.min(0.4, a * 2.2)})`;
        ctx.fillRect(-half + s * 0.24, -half - s * 0.05, Math.max(1.5, s * 0.05), s * 0.14);
        ctx.fillRect(half - s * 0.24 - Math.max(1.5, s * 0.05), -half - s * 0.05, Math.max(1.5, s * 0.05), s * 0.14);
        // Days: 5 columns x 4 rows.
        const gx = (s * 0.8) / 5;
        const gy = (s - head - s * 0.18) / 4;
        for (let i = 0; i < 20; i++) {
          const dx = -half + s * 0.1 + gx * (i % 5) + gx / 2;
          const dy = -half + head + s * 0.08 + gy * Math.floor(i / 5) + gy / 2;
          if (i === p.circled) {
            const pulse = 0.5 + 0.5 * Math.sin(secs * 1.6 + p.phase);
            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.7, a * (2.4 + pulse * 1.6))})`;
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.arc(dx, dy, gx * (0.42 + pulse * 0.08), 0, Math.PI * 2);
            ctx.stroke();
          } else {
            ctx.fillStyle = `rgba(${ink}, ${Math.min(0.3, a * 1.6)})`;
            ctx.fillRect(dx - gx * 0.2, dy - gy * 0.1, gx * 0.4, Math.max(1.2, gy * 0.2));
          }
        }
        ctx.restore();
      }
    },
  };
}

export function RenewalsBackdrop() {
  return <CanvasBackdrop glow="renewals" createRenderer={createPages} />;
}
