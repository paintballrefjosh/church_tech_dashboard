"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Admin backdrop: cogs turning slowly at their own speeds and directions (larger
 * gears turn slower, like a real gear train) — the universal settings motif.
 * Neutral slate, brighter in dark mode; the hub is punched out with an even-odd
 * fill so the glow shows through. Built on the shared <CanvasBackdrop>.
 */

interface Gear {
  x: number;
  y: number;
  radius: number; // tip radius
  teeth: number;
  speed: number; // rad/sec (signed for direction)
  phase: number; // starting rotation
}

function createGears(): BackdropRenderer {
  let gears: Gear[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(12, Math.max(5, Math.floor((width * height) / 120000)));
      gears = Array.from({ length: count }, (_, i) => {
        const radius = Math.random() * 34 + 26; // 26..60 px
        return {
          x: Math.random() * width,
          y: Math.random() * height,
          radius,
          teeth: Math.round(radius / 5) + 6,
          // Bigger gears turn slower; alternate direction.
          speed: (i % 2 === 0 ? 1 : -1) * (0.5 / (radius / 34)),
          phase: Math.random() * Math.PI * 2,
        };
      });
    },

    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = dark ? [148, 163, 184] : [71, 85, 105]; // slate-400 / 600
      const fillA = dark ? 0.12 : 0.09;
      const strokeA = dark ? 0.22 : 0.16;
      const secs = t / 1000;

      for (const gr of gears) {
        drawGear(ctx, gr, secs, r, g, b, fillA, strokeA);
      }
    },
  };
}

function drawGear(
  ctx: CanvasRenderingContext2D,
  gear: Gear,
  secs: number,
  r: number,
  g: number,
  b: number,
  fillA: number,
  strokeA: number,
) {
  const Ro = gear.radius;
  const Rr = Ro * 0.78; // root radius (valley between teeth)
  const Rh = Ro * 0.34; // hub hole radius
  const angle = gear.phase + secs * gear.speed;

  ctx.save();
  ctx.translate(gear.x, gear.y);
  ctx.rotate(angle);

  // Cog outline: per tooth, valley -> up -> tip -> down.
  ctx.beginPath();
  const T = gear.teeth;
  for (let k = 0; k < T; k++) {
    const samples: Array<[number, number]> = [
      [0.0, Rr],
      [0.14, Ro],
      [0.36, Ro],
      [0.5, Rr],
    ];
    for (const [frac, rad] of samples) {
      const a = ((k + frac) / T) * Math.PI * 2;
      const px = Math.cos(a) * rad;
      const py = Math.sin(a) * rad;
      if (k === 0 && frac === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
  }
  ctx.closePath();

  // Hub hole, wound the opposite way so even-odd punches it out.
  ctx.moveTo(Rh, 0);
  ctx.arc(0, 0, Rh, 0, Math.PI * 2, true);

  ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${fillA})`;
  ctx.fill("evenodd");
  ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${strokeA})`;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

export function AdminBackdrop() {
  return <CanvasBackdrop glow="admin" createRenderer={createGears} />;
}
