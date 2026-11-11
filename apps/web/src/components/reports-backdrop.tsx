"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Reports backdrop: small bar charts drifting upward, their bars slowly rising and falling, each with a faint trend line
 * across the tops and a baseline. Emerald / sky / indigo hues. Deterministic time-based tracks, so it survives resize and
 * the reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Chart {
  baseX: number;
  w: number;
  h: number;
  bars: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  levels: number[];
  color: number;
  alpha: number;
}

const PALETTE: Array<[number, number, number]> = [
  [16, 185, 129], // emerald
  [14, 165, 233], // sky
  [99, 102, 241], // indigo
];

function createCharts(): BackdropRenderer {
  let charts: Chart[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(14, Math.max(5, Math.floor((width * height) / 90000)));
      charts = Array.from({ length: count }, () => {
        const bars = Math.floor(Math.random() * 3) + 4;
        return {
          baseX: Math.random(),
          w: Math.random() * 30 + 56,
          h: Math.random() * 20 + 40,
          bars,
          speed: Math.random() * 9 + 5,
          offset: Math.random(),
          swayAmp: Math.random() * 8 + 3,
          swayFreq: Math.random() * 0.3 + 0.2,
          phase: Math.random() * Math.PI * 2,
          levels: Array.from({ length: bars }, () => Math.random() * 0.6 + 0.3),
          color: Math.floor(Math.random() * PALETTE.length),
          alpha: Math.random() * 0.06 + 0.15,
        };
      });
    },
    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const ink = dark ? "203, 213, 225" : "71, 85, 105";
      for (const c of charts) {
        const travel = height + c.h * 2;
        const prog = ((c.speed * secs + c.offset * travel) % travel + travel) % travel;
        const base = height + c.h - prog;
        const left = c.baseX * width + Math.sin(secs * c.swayFreq + c.phase) * c.swayAmp - c.w / 2;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = c.alpha * edge;
        if (a <= 0.004) continue;
        const col = PALETTE[c.color];
        if (!col) continue;
        const [r, g, b] = col;
        const slot = c.w / c.bars;
        const bw = slot * 0.62;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        const tops: Array<[number, number]> = [];
        for (let i = 0; i < c.bars; i++) {
          const lvl = c.levels[i] ?? 0.5;
          const bh = c.h * Math.max(0.12, Math.min(1, lvl + 0.18 * Math.sin(secs * 0.5 + c.phase + i * 1.3)));
          const x = left + i * slot + (slot - bw) / 2;
          ctx.fillRect(x, base - bh, bw, bh);
          tops.push([x + bw / 2, base - bh]);
        }
        // Trend line across the bar tops, and the baseline.
        ctx.strokeStyle = `rgba(${ink}, ${Math.min(0.4, a * 2)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        tops.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y - 4) : ctx.lineTo(x, y - 4)));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(left - 2, base + 1);
        ctx.lineTo(left + c.w + 2, base + 1);
        ctx.stroke();
      }
    },
  };
}

export function ReportsBackdrop() {
  return <CanvasBackdrop glow="reports" createRenderer={createCharts} />;
}
