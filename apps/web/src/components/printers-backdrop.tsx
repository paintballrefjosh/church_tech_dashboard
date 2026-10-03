"use client";

import { CanvasBackdrop, type BackdropRenderer } from "./fx-backdrop";

/**
 * Printers backdrop: a CMYK halftone raster — the dot screen a printer lays ink
 * down with. Dots sit on a fixed grid, cycling through cyan/magenta/yellow/black
 * in a 2x2 rosette, and a diagonal wave sweeps their size + opacity so the whole
 * screen ripples like a print head passing over the page. K (black) inverts to a
 * light grey in dark mode so it stays visible. Built on the shared
 * <CanvasBackdrop>.
 */

const CHANNELS_LIGHT: Array<[number, number, number]> = [
  [34, 211, 238], // C
  [232, 121, 249], // M
  [250, 204, 21], // Y
  [51, 65, 85], // K (slate-700 on light)
];
const CHANNELS_DARK: Array<[number, number, number]> = [
  [34, 211, 238], // C
  [232, 121, 249], // M
  [250, 204, 21], // Y
  [148, 163, 184], // K (slate-400 on dark)
];

function createHalftone(): BackdropRenderer {
  let gap = 34;

  return {
    seed({ width }) {
      // Slightly wider dot pitch on large screens to keep the fill-count sane.
      gap = width > 1600 ? 44 : 40;
    },

    frame({ ctx, width, height, dark, t }) {
      ctx.clearRect(0, 0, width, height);
      const secs = t / 1000;
      const maxR = gap * 0.42;
      const channels = dark ? CHANNELS_DARK : CHANNELS_LIGHT;
      const baseA = dark ? 0.18 : 0.14;
      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let gy = 0; gy < rows; gy++) {
        for (let gx = 0; gx < cols; gx++) {
          // Diagonal travelling wave (~10-dot wavelength) drives size + opacity.
          const wave = 0.5 + 0.5 * Math.sin((gx + gy) * 0.6 - secs * 1.8);
          const r = maxR * (0.12 + 0.88 * wave);
          if (r < 0.4) continue;
          const ch = channels[(gx & 1) + (gy & 1) * 2];
          if (!ch) continue;
          const a = baseA * (0.35 + 0.65 * wave);
          ctx.fillStyle = `rgba(${ch[0]}, ${ch[1]}, ${ch[2]}, ${a})`;
          ctx.beginPath();
          ctx.arc(gx * gap + gap / 2, gy * gap + gap / 2, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
  };
}

export function PrintersBackdrop() {
  return <CanvasBackdrop glow="print" createRenderer={createHalftone} />;
}
