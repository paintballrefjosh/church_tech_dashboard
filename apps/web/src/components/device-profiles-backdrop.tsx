"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Device profiles backdrop: switch and patch-panel faceplates sliding sideways at different speeds, each a slim rack unit
 * with rows of port sockets and a few status lights that blink on their own clocks. Indigo / slate with green and amber
 * lights. Deterministic time-based tracks, so it survives resize and the reduced-motion static frame. Built on the shared
 * <CanvasBackdrop>.
 */

interface Plate {
  y: number; // 0..1 fraction of height
  w: number;
  h: number;
  rows: number;
  speed: number; // px/sec, signed
  offset: number;
  alpha: number;
  blink: number;
  phase: number;
}

function createPlates(): BackdropRenderer {
  let plates: Plate[] = [];
  return {
    seed({ width, height }) {
      const count = Math.min(14, Math.max(6, Math.floor(height / 70)));
      plates = Array.from({ length: count }, (_, i) => {
        const rows = Math.random() < 0.5 ? 1 : 2;
        return {
          y: (i + Math.random() * 0.7) / count,
          w: Math.random() * 120 + Math.min(180, width * 0.25),
          h: rows === 1 ? 22 : 34,
          rows,
          speed: (Math.random() * 7 + 4) * (i % 2 === 0 ? 1 : -1),
          offset: Math.random(),
          alpha: Math.random() * 0.04 + 0.09,
          blink: Math.random() * 1.2 + 0.5,
          phase: Math.random() * Math.PI * 2,
        };
      });
    },
    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const body = dark ? "148, 163, 184" : "71, 85, 105";
      for (const p of plates) {
        const travel = width + p.w * 2;
        const prog = ((p.speed * secs + p.offset * travel) % travel + travel) % travel;
        const x = prog - p.w;
        const y = p.y * height;
        const edge = Math.max(0, Math.min(prog / (travel * 0.12), (travel - prog) / (travel * 0.12), 1));
        const a = p.alpha * edge;
        if (a <= 0.004) continue;
        ctx.fillStyle = `rgba(${body}, ${a})`;
        ctx.beginPath();
        ctx.roundRect(x, y, p.w, p.h, 3);
        ctx.fill();
        // Port sockets: two rows of 4-wide groups, like a 24 or 48 port switch.
        const port = 7;
        const gapX = 3;
        const per = Math.max(4, Math.floor((p.w - 40) / (port + gapX)));
        ctx.fillStyle = `rgba(${dark ? "226, 232, 240" : "30, 41, 59"}, ${Math.min(0.26, a * 1.9)})`;
        for (let row = 0; row < p.rows; row++) {
          for (let i = 0; i < per; i++) {
            const px = x + 8 + i * (port + gapX) + Math.floor(i / 4) * 3;
            if (px + port > x + p.w - 28) break;
            ctx.fillRect(px, y + 4 + row * 14, port, 8);
          }
        }
        // Status lights on the right, blinking.
        for (let k = 0; k < 2; k++) {
          const on = Math.sin(secs * p.blink + p.phase + k * 1.7) > -0.2;
          const lit = k === 0 ? "34, 197, 94" : "245, 158, 11";
          ctx.fillStyle = `rgba(${lit}, ${on ? Math.min(0.7, a * 4.5) : a * 0.8})`;
          ctx.beginPath();
          ctx.arc(x + p.w - 18 + k * 9, y + p.h / 2, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
  };
}

export function DeviceProfilesBackdrop() {
  return <CanvasBackdrop glow="brand" createRenderer={createPlates} />;
}
