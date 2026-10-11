import type { CSSProperties, ReactNode } from "react";

/**
 * A receding nave archway, drawn as pure SVG: a row of pointed arches recede toward a warm light
 * at the vanishing point. Shared by the sign-in page (`signin/chapel-window.tsx`) and the Nave
 * look of the home page, which differ only in the props below (colours, opacity ramp, stroke
 * widths, glow). Geometry comes from one perspective model (vanishing point + per-arch
 * interpolation), so spacing compresses correctly toward the light.
 *
 * Motion is the `auth-arch` / `auth-glow` classes in globals.css (entrance, glow breathing);
 * they are switched off under prefers-reduced-motion, which leaves the arches at rest.
 */

export interface ColorStop {
  /** Position along the nave: 0 = outer frame, 1 = the light. */
  at: number;
  rgb: readonly [number, number, number];
}

export interface GlowStop {
  /** 0 to 1. */
  offset: number;
  color: string;
  opacity: number;
}

export interface NaveGlow {
  shape: "ellipse" | "circle";
  /** Radii in viewBox units (`ry` is ignored for a circle). */
  rx: number;
  ry?: number;
  stops: readonly GlowStop[];
  /** Radial gradient geometry, as percentages of the shape's box. */
  gradient?: { cx: number; cy: number; r: number };
  /** A small bright disc at the vanishing point. */
  core?: { r: number; color: string; opacity: number };
  /** CSS mix-blend-mode for the glow (the light scheme uses "multiply"). */
  blend?: CSSProperties["mixBlendMode"];
}

export interface NaveShaft {
  color: string;
  opacity: number;
  /** Half-width of the beam at the light and at the bottom edge. */
  topHalf: number;
  bottomHalf: number;
}

export interface NaveArchesProps {
  className?: string;
  viewBox?: { width: number; height: number };
  /** Horizontal centre and vanishing point (viewBox units). */
  cx?: number;
  vpY?: number;
  count?: number;
  /** Half-width of the opening: [outermost, innermost]. */
  halfWidth?: readonly [number, number];
  /** Apex height of the point: [outermost, innermost]. Default: [64, vpY - 6]. */
  apexY?: readonly [number, number];
  /** Where the jambs end: [outermost, innermost]. Default: [height + 148, vpY + 10]. */
  sillY?: readonly [number, number];
  /** Perspective exponent: higher compresses the inner arches harder. */
  perspective?: number;
  colorStops: readonly ColorStop[];
  /** Stroke opacity: [outermost, innermost]. */
  opacity?: readonly [number, number];
  /** Stroke width: [outermost, innermost]. */
  strokeWidth?: readonly [number, number];
  /** Entrance delay: [innermost arch's delay, extra delay for the outermost]. Outer arches resolve first. */
  delay?: readonly [number, number];
  glow?: NaveGlow;
  shaft?: NaveShaft;
  /** Prefix for the SVG gradient ids, so two instances on one page do not clash. */
  idPrefix?: string;
  /** Drawn first, behind everything (the sign-in page's background gradient). */
  children?: ReactNode;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function colorAt(stops: readonly ColorStop[], t: number): string {
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (!first || !last) return "currentColor";
  let a = first;
  let b = last;
  if (t <= first.at) b = first;
  else if (t >= last.at) a = last;
  else {
    for (let i = 0; i < stops.length - 1; i++) {
      const s0 = stops[i]!;
      const s1 = stops[i + 1]!;
      if (t >= s0.at && t <= s1.at) {
        a = s0;
        b = s1;
        break;
      }
    }
  }
  const span = b.at - a.at;
  const u = span <= 0 ? 0 : (t - a.at) / span;
  const c = (i: 0 | 1 | 2) => Math.round(lerp(a.rgb[i], b.rgb[i], u));
  return `rgb(${c(0)}, ${c(1)}, ${c(2)})`;
}

export function NaveArches({
  className,
  viewBox = { width: 600, height: 800 },
  cx = 300,
  vpY = 358,
  count = 9,
  halfWidth = [372, 16],
  apexY,
  sillY,
  perspective = 1.55,
  colorStops,
  opacity = [0.12, 0.95],
  strokeWidth = [1.5, 1.5],
  delay = [0.15, 0.5],
  glow,
  shaft,
  idPrefix = "nave",
  children,
}: NaveArchesProps) {
  const apex = apexY ?? [64, vpY - 6];
  const sill = sillY ?? [viewBox.height + 148, vpY + 10];
  const arches = Array.from({ length: count }, (_, k) => {
    const t = count > 1 ? k / (count - 1) : 1;
    const te = Math.pow(t, perspective);
    const w = lerp(halfWidth[0], halfWidth[1], te);
    const apexAt = lerp(apex[0], apex[1], te);
    const springY = apexAt + w * 1.5; // jambs meet the two-centred head here
    const sillAt = lerp(sill[0], sill[1], te);
    // Pointed (two-centred) head: each side is a wide-radius arc rising from a jamb to the peak.
    const r = w * 1.5;
    const d =
      `M ${cx - w} ${sillAt} L ${cx - w} ${springY} ` +
      `A ${r} ${r} 0 0 1 ${cx} ${apexAt} ` +
      `A ${r} ${r} 0 0 1 ${cx + w} ${springY} L ${cx + w} ${sillAt}`;
    return {
      d,
      color: colorAt(colorStops, t),
      opacity: lerp(opacity[0], opacity[1], t),
      width: lerp(strokeWidth[0], strokeWidth[1], t),
      delay: `${delay[0] + (1 - t) * delay[1]}s`,
    };
  });

  const origin = `${cx}px ${vpY}px`;
  const glowId = `${idPrefix}-glow`;
  const shaftId = `${idPrefix}-shaft`;
  const gp = glow?.gradient ?? { cx: 50, cy: 50, r: 50 };

  return (
    <svg
      className={className}
      viewBox={`0 0 ${viewBox.width} ${viewBox.height}`}
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
      focusable="false"
    >
      <defs>
        {glow ? (
          <radialGradient id={glowId} cx={`${gp.cx}%`} cy={`${gp.cy}%`} r={`${gp.r}%`}>
            {glow.stops.map((s) => (
              <stop key={s.offset} offset={`${s.offset * 100}%`} stopColor={s.color} stopOpacity={s.opacity} />
            ))}
          </radialGradient>
        ) : null}
        {shaft ? (
          <linearGradient id={shaftId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={shaft.color} stopOpacity={shaft.opacity} />
            <stop offset="100%" stopColor={shaft.color} stopOpacity="0" />
          </linearGradient>
        ) : null}
      </defs>

      {children}

      {shaft ? (
        <polygon
          className="auth-glow"
          style={{ transformOrigin: origin }}
          points={`${cx - shaft.topHalf},${vpY} ${cx + shaft.topHalf},${vpY} ${cx + shaft.bottomHalf},${viewBox.height} ${cx - shaft.bottomHalf},${viewBox.height}`}
          fill={`url(#${shaftId})`}
        />
      ) : null}

      {glow ? (
        <g className="auth-glow" style={{ transformOrigin: origin, mixBlendMode: glow.blend }}>
          {glow.shape === "ellipse" ? (
            <ellipse cx={cx} cy={vpY} rx={glow.rx} ry={glow.ry ?? glow.rx} fill={`url(#${glowId})`} />
          ) : (
            <circle cx={cx} cy={vpY} r={glow.rx} fill={`url(#${glowId})`} />
          )}
          {glow.core ? (
            <circle cx={cx} cy={vpY} r={glow.core.r} fill={glow.core.color} opacity={glow.core.opacity} />
          ) : null}
        </g>
      ) : null}

      <g fill="none" strokeLinecap="round">
        {arches.map((a, i) => (
          <path
            key={i}
            className="auth-arch"
            d={a.d}
            stroke={a.color}
            strokeOpacity={a.opacity}
            strokeWidth={a.width}
            vectorEffect="non-scaling-stroke"
            style={{ animationDelay: a.delay, transformOrigin: origin } as CSSProperties}
          />
        ))}
      </g>
    </svg>
  );
}
