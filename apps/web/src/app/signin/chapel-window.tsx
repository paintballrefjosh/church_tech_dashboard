import type { CSSProperties } from "react";

/**
 * "Toward the light" — a receding nave archway, drawn as pure SVG. A row of
 * Romanesque arches recede toward a warm light at the vanishing point, the way
 * a church interior draws the eye to the altar. No literal/kitsch imagery; the
 * architecture alone carries the meaning.
 *
 * Geometry is generated from a single perspective model (vanishing point +
 * per-arch interpolation), so the spacing compresses correctly toward the
 * light instead of being hand-placed. All motion is CSS (`auth-*` in
 * globals.css) and is disabled under prefers-reduced-motion.
 */

const CX = 300; // horizontal centre of the nave (viewBox is 600 wide)
const VP_Y = 358; // vanishing point, lifted slightly above centre
const N = 9; // number of receding arches

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Cool indigo for the distant outer frame -> warm candlelight near the light.
function strokeColor(t: number): string {
  const r = Math.round(lerp(0x6b, 0xff, t));
  const g = Math.round(lerp(0x74, 0xe4, t));
  const b = Math.round(lerp(0xd6, 0xb0, t));
  return `rgb(${r}, ${g}, ${b})`;
}

interface Arch {
  d: string;
  color: string;
  opacity: number;
  delay: string;
}

const arches: Arch[] = Array.from({ length: N }, (_, k): Arch => {
  const t = k / (N - 1);
  const te = Math.pow(t, 1.55); // perspective compression toward the vp
  const w = lerp(372, 16, te); // half-width of the opening
  const apexY = lerp(64, VP_Y - 6, te); // the point of the lancet
  const springY = apexY + w * 1.5; // jambs meet the two-centred head here
  const sillY = lerp(948, VP_Y + 10, te);
  // Pointed (two-centred) Gothic head: each side is a wide-radius arc rising
  // from a jamb to the central peak. R > chord/2 keeps both arcs valid.
  const r = w * 1.5;
  const d =
    `M ${CX - w} ${sillY} L ${CX - w} ${springY} ` +
    `A ${r} ${r} 0 0 1 ${CX} ${apexY} ` +
    `A ${r} ${r} 0 0 1 ${CX + w} ${springY} L ${CX + w} ${sillY}`;
  return {
    d,
    color: strokeColor(t),
    opacity: lerp(0.12, 0.95, t),
    // Outer arches resolve first; the light "arrives" last.
    delay: `${0.15 + (1 - t) * 0.5}s`,
  };
});

export function ChapelWindow() {
  return (
    <svg
      className="absolute inset-0 h-full w-full"
      viewBox="0 0 600 800"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <linearGradient id="nave-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0e1238" />
          <stop offset="55%" stopColor="#0a0c28" />
          <stop offset="100%" stopColor="#06061a" />
        </linearGradient>
        <radialGradient
          id="nave-glow"
          cx="50%"
          cy={`${(VP_Y / 800) * 100}%`}
          r="44%"
        >
          <stop offset="0%" stopColor="#ffe7b3" stopOpacity="0.95" />
          <stop offset="28%" stopColor="#f2b878" stopOpacity="0.5" />
          <stop offset="68%" stopColor="#5b6bd6" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#5b6bd6" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="nave-shaft" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ffe2a6" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffe2a6" stopOpacity="0" />
        </linearGradient>
      </defs>

      <rect width="600" height="800" fill="url(#nave-bg)" />

      {/* A soft shaft of light spilling down the nave from the source. */}
      <polygon
        className="auth-glow"
        points={`${CX - 14},${VP_Y} ${CX + 14},${VP_Y} ${CX + 120},800 ${CX - 120},800`}
        fill="url(#nave-shaft)"
      />

      {/* The light at the end of the nave. */}
      <g className="auth-glow">
        <ellipse cx={CX} cy={VP_Y} rx="230" ry="250" fill="url(#nave-glow)" />
        <circle cx={CX} cy={VP_Y} r="17" fill="#fff4da" opacity="0.85" />
      </g>

      {/* Receding arches. */}
      <g fill="none" strokeLinecap="round">
        {arches.map((a, i) => (
          <path
            key={i}
            className="auth-arch"
            d={a.d}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            style={{ animationDelay: a.delay } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
