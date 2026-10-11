import { NaveArches } from "@/components/nave-arches";

/**
 * "Toward the light": the receding nave archway of the sign-in page. The geometry and motion live
 * in the shared `NaveArches` (also used by the home page's Nave look); this file only supplies the
 * sign-in colours: cool indigo for the distant frame, warm candlelight near the light.
 */
const VP_Y = 358;

export function ChapelWindow() {
  return (
    <NaveArches
      className="absolute inset-0 h-full w-full"
      viewBox={{ width: 600, height: 800 }}
      cx={300}
      vpY={VP_Y}
      count={9}
      halfWidth={[372, 16]}
      colorStops={[
        { at: 0, rgb: [0x6b, 0x74, 0xd6] },
        { at: 1, rgb: [0xff, 0xe4, 0xb0] },
      ]}
      opacity={[0.12, 0.95]}
      strokeWidth={[1.5, 1.5]}
      shaft={{ color: "#ffe2a6", opacity: 0.22, topHalf: 14, bottomHalf: 120 }}
      glow={{
        shape: "ellipse",
        rx: 230,
        ry: 250,
        gradient: { cx: 50, cy: (VP_Y / 800) * 100, r: 44 },
        stops: [
          { offset: 0, color: "#ffe7b3", opacity: 0.95 },
          { offset: 0.28, color: "#f2b878", opacity: 0.5 },
          { offset: 0.68, color: "#5b6bd6", opacity: 0.14 },
          { offset: 1, color: "#5b6bd6", opacity: 0 },
        ],
        core: { r: 17, color: "#fff4da", opacity: 0.85 },
      }}
    >
      <defs>
        <linearGradient id="nave-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e1238" />
          <stop offset="55%" stopColor="#0a0c28" />
          <stop offset="100%" stopColor="#06061a" />
        </linearGradient>
      </defs>
      <rect width="600" height="800" fill="url(#nave-bg)" />
    </NaveArches>
  );
}
