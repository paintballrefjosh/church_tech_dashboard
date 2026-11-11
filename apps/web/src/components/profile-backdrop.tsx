"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Profile backdrop (My account): round avatar badges, each a head and shoulders in a circle, drifting slowly upward with
 * a gentle sway. Never a real face or name, just the generic silhouette. Indigo / sky / rose / emerald hues. Deterministic
 * time-based tracks, so it survives resize and the reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Badge {
  baseX: number;
  size: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  color: number;
  alpha: number;
}

const PALETTE: Array<[number, number, number]> = [
  [99, 102, 241], // indigo
  [14, 165, 233], // sky
  [244, 63, 94], // rose
  [16, 185, 129], // emerald
];

function createBadges(): BackdropRenderer {
  let badges: Badge[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(18, Math.max(7, Math.floor((width * height) / 70000)));
      badges = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 20 + 30,
        speed: Math.random() * 10 + 6,
        offset: Math.random(),
        swayAmp: Math.random() * 9 + 4,
        swayFreq: Math.random() * 0.3 + 0.2,
        phase: Math.random() * Math.PI * 2,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.06 + 0.14,
      }));
    },
    frame({ ctx, width, height, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      for (const p of badges) {
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
        const rad = s / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.7})`;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.fill();
        // Head and shoulders, clipped to the badge.
        ctx.save();
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 1.6})`;
        ctx.beginPath();
        ctx.arc(0, -rad * 0.16, rad * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(0, rad * 0.78, rad * 0.62, rad * 0.46, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a * 1.2})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(0, 0, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    },
  };
}

export function ProfileBackdrop() {
  return <CanvasBackdrop glow="profile" createRenderer={createBadges} />;
}
