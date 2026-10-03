"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Notifications backdrop: notification bells drifting upward and gently ringing
 * (rocking side to side), a few wearing a little unread-count dot — the
 * notification-centre motif. Rose/amber, brighter in dark mode. Each rides a
 * deterministic time-based track so it survives resize + the reduced-motion
 * static frame. Built on the shared <CanvasBackdrop>.
 */

interface Bell {
  baseX: number;
  size: number;
  speed: number;
  offset: number;
  swayAmp: number;
  swayFreq: number;
  phase: number;
  ringFreq: number; // rocking speed
  badge: boolean;
  color: number;
  alpha: number;
}

const PALETTE: Array<[number, number, number]> = [
  [251, 113, 133], // rose
  [251, 146, 60], // orange
  [245, 158, 11], // amber
];

function createBells(): BackdropRenderer {
  let bells: Bell[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(20, Math.max(7, Math.floor((width * height) / 66000)));
      bells = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        size: Math.random() * 20 + 26,
        speed: Math.random() * 12 + 7,
        offset: Math.random(),
        swayAmp: Math.random() * 9 + 5,
        swayFreq: Math.random() * 0.35 + 0.25,
        phase: Math.random() * Math.PI * 2,
        ringFreq: Math.random() * 1.4 + 1.4,
        badge: Math.random() < 0.4,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.07 + 0.14,
      }));
    },

    frame({ ctx, width, height, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;

      for (const bl of bells) {
        const s = bl.size;
        const travel = height + s * 2;
        const prog = (((bl.speed * secs) + bl.offset * travel) % travel + travel) % travel;
        const cy = height + s - prog;
        const cx = bl.baseX * width + Math.sin(secs * bl.swayFreq + bl.phase) * bl.swayAmp;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = bl.alpha * edge;
        if (a <= 0.004) continue;
        const col = PALETTE[bl.color];
        if (!col) continue;
        const rock = Math.sin(secs * bl.ringFreq + bl.phase) * 0.16;
        drawBell(ctx, cx, cy, s, rock, bl.badge, col, a);
      }
    },
  };
}

function drawBell(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  s: number,
  rock: number,
  badge: boolean,
  [r, g, b]: [number, number, number],
  a: number,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rock); // pivot at the crown for a ringing wobble
  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
  ctx.lineWidth = Math.max(1, s * 0.06);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  const w = s * 0.72; // bell mouth half-width
  const top = -s * 0.42;
  const bot = s * 0.34;

  // Crown nub.
  ctx.beginPath();
  ctx.arc(0, top - s * 0.08, s * 0.07, 0, Math.PI * 2);
  ctx.fill();

  // Body: shoulders flare out to the mouth.
  ctx.beginPath();
  ctx.moveTo(-w * 0.28, top);
  ctx.quadraticCurveTo(-w * 0.34, top, -w * 0.4, top + s * 0.14);
  ctx.quadraticCurveTo(-w, bot - s * 0.12, -w, bot);
  ctx.lineTo(w, bot);
  ctx.quadraticCurveTo(w, bot - s * 0.12, w * 0.4, top + s * 0.14);
  ctx.quadraticCurveTo(w * 0.34, top, w * 0.28, top);
  ctx.closePath();
  ctx.stroke();

  // Clapper.
  ctx.beginPath();
  ctx.arc(0, bot + s * 0.09, s * 0.08, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  // Unread badge (unrotated, top-right).
  if (badge) {
    ctx.fillStyle = `rgba(244, 63, 94, ${Math.min(0.8, a * 3)})`;
    ctx.beginPath();
    ctx.arc(cx + s * 0.42, cy - s * 0.42, s * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function NotificationsBackdrop() {
  return <CanvasBackdrop glow="notifications" createRenderer={createBells} />;
}
