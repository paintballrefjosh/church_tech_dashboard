"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Rooms backdrop: a floor plan set adrift. Outlined rooms of different sizes drift slowly up and to one side, each with a
 * door gap in one wall and the swing of the door drawn as a quarter circle. Line work only, so it stays calm behind text.
 * Rose / violet / sky / slate hues. Deterministic time-based tracks, so it survives resize and the reduced-motion static
 * frame. Built on the shared <CanvasBackdrop>.
 */

interface Room {
  baseX: number;
  w: number;
  h: number;
  speed: number;
  offset: number;
  drift: number;
  color: number;
  alpha: number;
  doorSide: number; // 0 bottom, 1 right
}

const PALETTE: Array<[number, number, number]> = [
  [236, 72, 153], // pink
  [139, 92, 246], // violet
  [14, 165, 233], // sky
  [100, 116, 139], // slate
];

function createRooms(): BackdropRenderer {
  let rooms: Room[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(16, Math.max(6, Math.floor((width * height) / 80000)));
      rooms = Array.from({ length: count }, () => ({
        baseX: Math.random(),
        w: Math.random() * 60 + 50,
        h: Math.random() * 50 + 40,
        speed: Math.random() * 8 + 5,
        offset: Math.random(),
        drift: (Math.random() - 0.5) * 10,
        color: Math.floor(Math.random() * PALETTE.length),
        alpha: Math.random() * 0.08 + 0.2,
        doorSide: Math.random() < 0.5 ? 0 : 1,
      }));
    },
    frame({ ctx, width, height, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      for (const r of rooms) {
        const travel = height + r.h * 2;
        const prog = ((r.speed * secs + r.offset * travel) % travel + travel) % travel;
        const top = height + r.h - prog - r.h / 2;
        const left = r.baseX * width + r.drift * secs * 0.2 - r.w / 2;
        const edge = Math.max(0, Math.min(prog / (travel * 0.13), (travel - prog) / (travel * 0.18), 1));
        const a = r.alpha * edge;
        if (a <= 0.004) continue;
        const col = PALETTE[r.color];
        if (!col) continue;
        const [cr, cg, cb] = col;
        const gap = Math.min(r.w, r.h) * 0.36;
        ctx.save();
        ctx.translate(left, top);
        ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${a})`;
        ctx.lineWidth = 1.6;
        ctx.lineJoin = "round";
        ctx.beginPath();
        if (r.doorSide === 0) {
          // Door gap in the bottom wall, hinged at its left end.
          const gx = r.w * 0.2;
          ctx.moveTo(gx + gap, r.h);
          ctx.lineTo(r.w, r.h);
          ctx.lineTo(r.w, 0);
          ctx.lineTo(0, 0);
          ctx.lineTo(0, r.h);
          ctx.lineTo(gx, r.h);
          ctx.moveTo(gx, r.h);
          ctx.lineTo(gx, r.h - gap);
          ctx.moveTo(gx + gap, r.h);
          ctx.arc(gx, r.h, gap, 0, -Math.PI / 2, true);
        } else {
          // Door gap in the right wall, hinged at its top end.
          const gy = r.h * 0.2;
          ctx.moveTo(r.w, gy + gap);
          ctx.lineTo(r.w, r.h);
          ctx.lineTo(0, r.h);
          ctx.lineTo(0, 0);
          ctx.lineTo(r.w, 0);
          ctx.lineTo(r.w, gy);
          ctx.moveTo(r.w, gy);
          ctx.lineTo(r.w - gap, gy);
          ctx.moveTo(r.w - gap, gy);
          ctx.arc(r.w, gy, gap, Math.PI, Math.PI / 2, true);
        }
        ctx.stroke();
        ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${a * 0.18})`;
        ctx.fillRect(0, 0, r.w, r.h);
        ctx.restore();
      }
    },
  };
}

export function RoomsBackdrop() {
  return <CanvasBackdrop glow="rooms" createRenderer={createRooms} />;
}
