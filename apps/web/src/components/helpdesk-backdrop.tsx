"use client";

import { CanvasBackdrop, type BackdropFrame, type BackdropRenderer } from "./fx-backdrop";

/**
 * Help Desk backdrop: support conversations drifting gently upward and swaying,
 * like tickets moving through and off a queue. Most are "open" (brand periwinkle,
 * a couple of message lines inside); a few are "resolved" (emerald, a checkmark).
 * Each rises on a deterministic time-based track so it survives resize and the
 * reduced-motion static frame. Built on the shared <CanvasBackdrop>.
 */

interface Bubble {
  baseX: number; // 0..1 fraction of width
  size: number; // bubble width in px
  speed: number; // px/sec upward
  offset: number; // 0..1 initial position along its track
  swayAmp: number;
  swayFreq: number;
  phase: number;
  resolved: boolean;
  alpha: number;
}

/** Rounded-rectangle path (roundRect isn't universally typed in our TS lib). */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function createConversations(): BackdropRenderer {
  let bubbles: Bubble[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(24, Math.max(8, Math.floor((width * height) / 52000)));
      bubbles = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 26 + 24, // 24..50 px wide
        speed: Math.random() * 14 + 8, // 8..22 px/s
        offset: Math.random(),
        swayAmp: Math.random() * 10 + 6,
        swayFreq: Math.random() * 0.4 + 0.3,
        phase: Math.random() * Math.PI * 2,
        resolved: Math.random() < 0.28,
        alpha: Math.random() * 0.06 + (Math.random() < 0.5 ? 0.14 : 0.18),
      }));
    },

    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const open: [number, number, number] = dark ? [129, 141, 225] : [79, 93, 201];
      const done: [number, number, number] = dark ? [52, 211, 153] : [16, 185, 129];

      for (const b of bubbles) {
        const w = b.size;
        const h = w * 0.72;
        const travel = height + h * 2;
        const prog = (((b.speed * secs) + b.offset * travel) % travel + travel) % travel;
        const cy = height + h - prog; // rises from below to above
        const cx = b.baseX * width + Math.sin(secs * b.swayFreq + b.phase) * b.swayAmp;

        // Soft fade in at the bottom, out at the top, so nothing pops.
        const edge = Math.max(0, Math.min(prog / (travel * 0.14), (travel - prog) / (travel * 0.2), 1));
        const a = b.alpha * edge;
        if (a <= 0.004) continue;

        const [cr, cg, cb] = b.resolved ? done : open;
        const x = cx - w / 2;
        const y = cy - h / 2;
        const rr = Math.min(h / 2, w * 0.28);

        // Body.
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`;
        roundRectPath(ctx, x, y, w, h, rr);
        ctx.fill();
        // Tail, bottom-left.
        ctx.beginPath();
        ctx.moveTo(x + w * 0.18, y + h);
        ctx.lineTo(x + w * 0.04, y + h + h * 0.28);
        ctx.lineTo(x + w * 0.36, y + h);
        ctx.closePath();
        ctx.fill();

        // Contents: message lines (open) or a checkmark (resolved).
        const ink = `rgba(${cr}, ${cg}, ${cb}, ${Math.min(0.6, a * 2.6)})`;
        if (b.resolved) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = Math.max(1, h * 0.11);
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.beginPath();
          ctx.moveTo(cx - w * 0.16, cy + h * 0.02);
          ctx.lineTo(cx - w * 0.03, cy + h * 0.17);
          ctx.lineTo(cx + w * 0.2, cy - h * 0.16);
          ctx.stroke();
        } else {
          ctx.fillStyle = ink;
          const lh = Math.max(1.4, h * 0.1);
          roundRectPath(ctx, cx - w * 0.28, cy - h * 0.16, w * 0.5, lh, lh / 2);
          ctx.fill();
          roundRectPath(ctx, cx - w * 0.28, cy + h * 0.06, w * 0.34, lh, lh / 2);
          ctx.fill();
        }
      }
    },
  };
}

export function HelpdeskBackdrop() {
  return <CanvasBackdrop glow="helpdesk" createRenderer={createConversations} />;
}
