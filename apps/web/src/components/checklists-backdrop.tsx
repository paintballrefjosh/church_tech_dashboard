"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Checklists backdrop: checkbox glyphs drifting upward, each periodically
 * getting ticked — the box fills and a checkmark draws on, then it clears and
 * repeats — evoking tasks being completed. Emerald/lime, brighter in dark mode.
 * Deterministic time-based tracks + tick cycles so it survives resize + the
 * reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Box {
  baseX: number;
  size: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  tickPeriod: number; // seconds per check/uncheck cycle
  tickOffset: number;
  alpha: number;
}

function createBoxes(): BackdropRenderer {
  let boxes: Box[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(22, Math.max(8, Math.floor((width * height) / 58000)));
      boxes = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 18 + 24, // 24..42 px
        speed: Math.random() * 12 + 7,
        offset: Math.random(),
        swayAmp: Math.random() * 8 + 4,
        swayFreq: Math.random() * 0.35 + 0.22,
        phase: Math.random() * Math.PI * 2,
        tickPeriod: Math.random() * 2.5 + 3, // 3..5.5s
        tickOffset: Math.random(),
        alpha: Math.random() * 0.07 + 0.15,
      }));
    },

    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const [r, g, b] = dark ? [52, 211, 153] : [13, 148, 136]; // emerald-400 / teal-600

      for (const bx of boxes) {
        const s = bx.size;
        const travel = height + s * 2;
        const prog = (((bx.speed * secs) + bx.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = bx.baseX * width + Math.sin(secs * bx.swayFreq + bx.phase) * bx.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = bx.alpha * edge;
        if (a <= 0.004) continue;

        // Tick cycle: 0..0.5 = drawing the check on (checked), 0.5..1 = empty.
        const cyc = ((secs / bx.tickPeriod) + bx.tickOffset) % 1;
        const checkProgress = cyc < 0.5 ? Math.min(1, cyc / 0.22) : 0; // draw-on then hold, clear in 2nd half
        drawBox(ctx, cx, cy, s, checkProgress, r, g, b, a);
      }
    },
  };
}

function drawBox(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  check: number, // 0..1 how much of the checkmark is drawn (0 = empty box)
  r: number,
  g: number,
  b: number,
  a: number,
) {
  const half = s / 2;
  const x = cx - half;
  const y = cy - half;
  const rr = s * 0.22;

  // Box outline.
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.55, a * 2.2)})`;
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + s, y, x + s, y + s, rr);
  ctx.arcTo(x + s, y + s, x, y + s, rr);
  ctx.arcTo(x, y + s, x, y, rr);
  ctx.arcTo(x, y, x + s, y, rr);
  ctx.closePath();
  ctx.stroke();

  if (check <= 0) return;

  // Fill tint grows in as it gets checked.
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a * 0.5 * check})`;
  ctx.fill();

  // Checkmark, drawn progressively (short leg first, then long leg).
  const p1 = { x: cx - s * 0.22, y: cy + s * 0.02 };
  const p2 = { x: cx - s * 0.04, y: cy + s * 0.2 };
  const p3 = { x: cx + s * 0.26, y: cy - s * 0.2 };
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(0.7, a * 3)})`;
  ctx.lineWidth = Math.max(1.2, s * 0.1);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(p1.x, p1.y);
  if (check < 0.5) {
    const k = check / 0.5;
    ctx.lineTo(p1.x + (p2.x - p1.x) * k, p1.y + (p2.y - p1.y) * k);
  } else {
    ctx.lineTo(p2.x, p2.y);
    const k = (check - 0.5) / 0.5;
    ctx.lineTo(p2.x + (p3.x - p2.x) * k, p2.y + (p3.y - p2.y) * k);
  }
  ctx.stroke();
}

export function ChecklistsBackdrop() {
  return <CanvasBackdrop glow="checklists" createRenderer={createBoxes} />;
}
