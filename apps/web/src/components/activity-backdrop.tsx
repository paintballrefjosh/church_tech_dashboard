"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Activity backdrop: expanding ripples, like pings on a radar — each a
 * "something happened" pulse rising somewhere on the surface, echoing a live
 * activity feed. Violet/fuchsia, brighter in dark mode. Positions and timing
 * are derived from the clock (a cheap hash per pulse cycle) so the field is
 * deterministic and survives resize + the reduced-motion static frame. Built on
 * the shared <CanvasBackdrop>.
 */

interface Pulse {
  life: number; // seconds per expand/fade cycle
  offset: number; // phase offset so pulses don't fire in unison
  salt: number; // per-pulse hash salt for its position each cycle
}

/** Cheap deterministic 0..1 hash. */
function hash(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function createPulses(): BackdropRenderer {
  let pulses: Pulse[] = [];

  return {
    seed({ width, height }) {
      const count = Math.min(18, Math.max(7, Math.floor((width * height) / 78000)));
      pulses = Array.from({ length: count }, (_, i) => ({
        life: 2.6 + hash(i * 1.7) * 2.2, // 2.6..4.8s
        offset: hash(i * 4.3) * 6,
        salt: i * 12.9898 + 1,
      }));
    },

    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const [r, g, b] = dark ? [167, 139, 250] : [124, 58, 237]; // violet-400 / 600
      const baseA = dark ? 0.3 : 0.2;
      const secs = t / 1000;

      for (const p of pulses) {
        const phase = secs + p.offset;
        const cycle = Math.floor(phase / p.life);
        const local = (phase % p.life) / p.life; // 0..1 within this cycle
        // New position each cycle so pulses roam the surface.
        const cx = hash(p.salt + cycle * 3.3) * width;
        const cy = hash(p.salt * 1.7 + cycle * 5.7) * height;
        const maxR = 55 + hash(p.salt + cycle * 2.1) * 95;

        const eased = 1 - (1 - local) * (1 - local); // easeOut expansion
        const radius = maxR * eased;
        const fade = 1 - local;

        // Expanding ring.
        ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${fade * baseA})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();

        // Origin dot, brightest at the start, shrinking as the ring leaves.
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${fade * Math.min(0.6, baseA * 1.8)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, 2.2 * fade + 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };
}

export function ActivityBackdrop() {
  return <CanvasBackdrop glow="activity" createRenderer={createPulses} />;
}
