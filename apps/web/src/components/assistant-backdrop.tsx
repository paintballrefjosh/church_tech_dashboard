"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Assistant backdrop: four-point sparkles twinkling and drifting slowly upward, a few larger and a scatter of tiny
 * motes between them. Violet / fuchsia / sky hues. Each sparkle breathes on its own clock; tracks are deterministic and
 * time-based, so it survives resize and the reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Spark {
  baseX: number;
  size: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  twinkle: number;
  color: number;
  alpha: number;
  mote: boolean;
}

const PALETTE: Array<[number, number, number]> = [
  [139, 92, 246], // violet
  [217, 70, 239], // fuchsia
  [56, 189, 248], // sky
  [99, 102, 241], // indigo
];

function createSparks(): BackdropRenderer {
  let sparks: Spark[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(30, Math.max(10, Math.floor((width * height) / 40000)));
      sparks = Array.from({ length: count }, (_, i) => {
        const mote = i % 3 === 0;
        return {
          baseX: Math.random(),
          size: mote ? Math.random() * 3 + 3 : Math.random() * 22 + 16,
          speed: Math.random() * 9 + 5,
          offset: Math.random(),
          swayAmp: Math.random() * 10 + 4,
          swayFreq: Math.random() * 0.3 + 0.2,
          phase: Math.random() * Math.PI * 2,
          twinkle: Math.random() * 0.9 + 0.5,
          color: Math.floor(Math.random() * PALETTE.length),
          alpha: Math.random() * 0.08 + 0.16,
          mote,
        };
      });
    },
    frame({ ctx, width, height, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      for (const p of sparks) {
        const s = p.size;
        const travel = height + s * 2;
        const prog = ((p.speed * secs + p.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = p.baseX * width + Math.sin(secs * p.swayFreq + p.phase) * p.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const breathe = 0.65 + 0.35 * Math.sin(secs * p.twinkle + p.phase);
        const a = p.alpha * edge * breathe;
        if (a <= 0.004) continue;
        const col = PALETTE[p.color];
        if (!col) continue;
        const [r, g, b] = col;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        if (p.mote) {
          ctx.beginPath();
          ctx.arc(cx, cy, s / 2, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }
        // Four-point star: concave sides drawn with curves through the centre.
        const k = s * (0.8 + 0.2 * breathe);
        ctx.beginPath();
        ctx.moveTo(cx, cy - k);
        ctx.quadraticCurveTo(cx, cy, cx + k, cy);
        ctx.quadraticCurveTo(cx, cy, cx, cy + k);
        ctx.quadraticCurveTo(cx, cy, cx - k, cy);
        ctx.quadraticCurveTo(cx, cy, cx, cy - k);
        ctx.closePath();
        ctx.fill();
      }
    },
  };
}

export function AssistantBackdrop() {
  return <CanvasBackdrop glow="assistant" createRenderer={createSparks} />;
}
