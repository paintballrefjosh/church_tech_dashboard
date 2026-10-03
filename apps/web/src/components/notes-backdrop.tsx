"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Notes backdrop: sticky notes drifting gently upward, each tilted a little and
 * slowly wobbling, with a folded corner and a couple of scribble lines — a
 * corkboard set adrift. Warm palette (amber / rose / lime / sky). Each note
 * rides a deterministic time-based track so it survives resize and the
 * reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Sticky {
  baseX: number; // 0..1 fraction of width
  size: number; // px
  speed: number; // px/sec upward
  offset: number; // 0..1 initial position along track
  swayAmp: number;
  swayFreq: number;
  phase: number;
  tilt: number; // base rotation (rad)
  wobbleFreq: number;
  color: number; // index into palette
  alpha: number;
}

// Warm sticky-note hues; readable in both themes.
const PALETTE: Array<[number, number, number]> = [
  [251, 191, 36], // amber
  [251, 113, 133], // rose
  [163, 230, 53], // lime
  [56, 189, 248], // sky
];

function createStickies(): BackdropRenderer {
  let notes: Sticky[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(22, Math.max(8, Math.floor((width * height) / 60000)));
      notes = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 24 + 34, // 34..58 px
        speed: Math.random() * 12 + 7, // 7..19 px/s
        offset: Math.random(),
        swayAmp: Math.random() * 9 + 5,
        swayFreq: Math.random() * 0.35 + 0.25,
        phase: Math.random() * Math.PI * 2,
        tilt: (Math.random() - 0.5) * 0.5, // ~ +/-14 deg
        wobbleFreq: Math.random() * 0.5 + 0.4,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.06 + 0.14,
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
        const [r, g, b] = col;
        const angle = n.tilt + Math.sin(secs * n.wobbleFreq + n.phase) * 0.05;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(angle);

        const half = s / 2;
        const fold = s * 0.24; // folded corner size (top-right)

        // Body with a dog-eared top-right corner.
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
        ctx.beginPath();
        ctx.moveTo(-half, -half);
        ctx.lineTo(half - fold, -half);
        ctx.lineTo(half, -half + fold);
        ctx.lineTo(half, half);
        ctx.lineTo(-half, half);
        ctx.closePath();
        ctx.fill();
        // The fold itself, a touch dimmer.
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.55})`;
        ctx.beginPath();
        ctx.moveTo(half - fold, -half);
        ctx.lineTo(half - fold, -half + fold);
        ctx.lineTo(half, -half + fold);
        ctx.closePath();
        ctx.fill();

        // A couple of scribble lines.
        ctx.fillStyle = `rgba(51, 65, 85, ${Math.min(0.42, a * 2.4)})`;
        const lh = Math.max(1.2, s * 0.06);
        ctx.fillRect(-half + s * 0.18, -s * 0.1, s * 0.5, lh);
        ctx.fillRect(-half + s * 0.18, s * 0.08, s * 0.36, lh);

        ctx.restore();
      }
    },
  };
}

export function NotesBackdrop() {
  return <CanvasBackdrop glow="notes" createRenderer={createStickies} />;
}
