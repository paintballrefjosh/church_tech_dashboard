"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Equipment backdrop: little isometric crates drifting slowly upward, each with a label tag on its front face, like stock
 * on a shelf set adrift. Orange / amber / slate hues, readable in both themes. Every crate rides a deterministic
 * time-based track so it survives resize and the reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Crate {
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
  [249, 115, 22], // orange
  [245, 158, 11], // amber
  [100, 116, 139], // slate
  [14, 165, 233], // sky
];

function createCrates(): BackdropRenderer {
  let crates: Crate[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(20, Math.max(7, Math.floor((width * height) / 65000)));
      crates = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 22 + 34,
        speed: Math.random() * 10 + 6,
        offset: Math.random(),
        swayAmp: Math.random() * 8 + 4,
        swayFreq: Math.random() * 0.3 + 0.2,
        phase: Math.random() * Math.PI * 2,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.06 + 0.14,
      }));
    },
    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      for (const c of crates) {
        const s = c.size;
        const travel = height + s * 2;
        const prog = ((c.speed * secs + c.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = c.baseX * width + Math.sin(secs * c.swayFreq + c.phase) * c.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = c.alpha * edge;
        if (a <= 0.004) continue;
        const col = PALETTE[c.color];
        if (!col) continue;
        const [r, g, b] = col;
        const w = s * 0.5;
        const h = s * 0.29;
        const d = s * 0.55;
        ctx.save();
        ctx.translate(cx, cy);
        // Top, left and right faces, lit from above.
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 1.15})`;
        ctx.beginPath();
        ctx.moveTo(0, -d / 2 - h);
        ctx.lineTo(w, -d / 2);
        ctx.lineTo(0, -d / 2 + h);
        ctx.lineTo(-w, -d / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.8})`;
        ctx.beginPath();
        ctx.moveTo(-w, -d / 2);
        ctx.lineTo(0, -d / 2 + h);
        ctx.lineTo(0, d / 2 + h);
        ctx.lineTo(-w, d / 2);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.5})`;
        ctx.beginPath();
        ctx.moveTo(0, -d / 2 + h);
        ctx.lineTo(w, -d / 2);
        ctx.lineTo(w, d / 2);
        ctx.lineTo(0, d / 2 + h);
        ctx.closePath();
        ctx.fill();
        // A label tag with a few barcode strokes on the right face.
        const ink = dark ? "226, 232, 240" : "51, 65, 85";
        ctx.fillStyle = `rgba(${ink}, ${Math.min(0.4, a * 2.2)})`;
        for (let i = 0; i < 4; i++) {
          const x = w * (0.2 + i * 0.16);
          ctx.fillRect(x, -d * 0.05 + h * (x / w) * 0.45, Math.max(1, s * 0.03), d * 0.3);
        }
        ctx.restore();
      }
    },
  };
}

export function AssetsBackdrop() {
  return <CanvasBackdrop glow="assets" createRenderer={createCrates} />;
}
