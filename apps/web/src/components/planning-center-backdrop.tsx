"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Planning Center backdrop: musical notes drifting gently upward and swaying,
 * for the worship-service plans and song lists PCO is built around. A warm
 * palette (amber / violet / pink); eighth notes get a flag, quarter notes don't.
 * Each rides a deterministic time-based track so it survives resize + the
 * reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Note {
  baseX: number; // 0..1 fraction of width
  size: number;
  speed: number; // px/sec upward
  offset: number; // 0..1 initial position along track
  swayAmp: number;
  swayFreq: number;
  phase: number;
  tilt: number;
  eighth: boolean; // flagged eighth note vs plain quarter
  color: number;
  alpha: number;
}

const PALETTE: Array<[number, number, number]> = [
  [245, 158, 11], // amber
  [167, 139, 250], // violet
  [244, 114, 182], // pink
];

function createNotes(): BackdropRenderer {
  let notes: Note[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(20, Math.max(7, Math.floor((width * height) / 64000)));
      notes = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 20 + 26, // 26..46 px
        speed: Math.random() * 12 + 7, // 7..19 px/s
        offset: Math.random(),
        swayAmp: Math.random() * 10 + 6,
        swayFreq: Math.random() * 0.4 + 0.25,
        phase: Math.random() * Math.PI * 2,
        tilt: (Math.random() - 0.5) * 0.3,
        eighth: Math.random() < 0.55,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.07 + 0.14,
      }));
    },

    frame({ ctx, width, height, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;

      for (const n of notes) {
        const s = n.size;
        const travel = height + s * 2;
        const prog = (((n.speed * secs) + n.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = n.baseX * width + Math.sin(secs * n.swayFreq + n.phase) * n.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = n.alpha * edge;
        if (a <= 0.004) continue;

        const col = PALETTE[n.color];
        if (!col) continue;
        drawNote(ctx, cx, cy, s, n.tilt + Math.sin(secs * n.swayFreq * 1.3 + n.phase) * 0.04, n.eighth, col, a);
      }
    },
  };
}

function drawNote(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  angle: number,
  eighth: boolean,
  [r, g, b]: [number, number, number],
  a: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a})`;

  const headRx = s * 0.28;
  const headRy = s * 0.2;
  const headX = -s * 0.14;
  const headY = s * 0.32;

  // Note head (a slightly tilted ellipse).
  ctx.save();
  ctx.translate(headX, headY);
  ctx.rotate(-0.35);
  ctx.beginPath();
  ctx.ellipse(0, 0, headRx, headRy, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Stem up from the head's right side.
  const stemX = headX + headRx * 0.92;
  const stemTop = headY - s * 0.86;
  ctx.lineWidth = Math.max(1, s * 0.055);
  ctx.beginPath();
  ctx.moveTo(stemX, headY - headRy * 0.2);
  ctx.lineTo(stemX, stemTop);
  ctx.stroke();

  // Flag for eighth notes.
  if (eighth) {
    ctx.lineWidth = Math.max(1.4, s * 0.09);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(stemX, stemTop);
    ctx.quadraticCurveTo(stemX + s * 0.34, stemTop + s * 0.16, stemX + s * 0.16, stemTop + s * 0.4);
    ctx.stroke();
  }

  ctx.restore();
}

export function PlanningCenterBackdrop() {
  return <CanvasBackdrop glow="pco" createRenderer={createNotes} />;
}
