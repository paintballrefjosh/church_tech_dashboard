"use client";

import type { CSSProperties } from "react";
import { RACK_ITEM_STYLE_LABELS, pictureFitsSlot, topU, type RackItemStyle, type RackItemView, type SwitchModel } from "@church/shared";
import { rackItemPicture, type RackPicture, type RackSide } from "@/lib/rack-pictures";

/**
 * A cabinet drawn as an elevation: U numbers down both rails, U1 at the bottom, each item filling the U it occupies,
 * with its picture (front or rear) when its switch model has one and a drawn stand-in when it has not.
 *
 * One component for the working page (`variant="screen"`: items and empty slots are buttons) and the sheet that is
 * printed (`variant="print"`: plain boxes, light colours, no names on the faces because the table beside the cabinet has
 * them). The row height is `--u`, set by the caller, so the printed table can use the same grid lines.
 */

interface Props {
  units: number;
  items: RackItemView[];
  models: readonly SwitchModel[];
  side: RackSide;
  variant: "screen" | "print";
  /** Print only: draw the model pictures (off = the plain drawn faces, which cost no ink). */
  pictures?: boolean;
  selectedId?: string | null;
  onSelect?: (item: RackItemView) => void;
  onEmpty?: (u: number) => void;
  /** Accessible name of the whole drawing. */
  label: string;
}

/** The highest U drawn: the cabinet's, or further when an item reaches past it (a cabinet made smaller later). */
export function drawnUnits(units: number, items: readonly RackItemView[]): number {
  return Math.max(units, ...items.map(topU));
}

const FACE: Record<RackItemStyle, { screen: string; print: string }> = {
  switch: { screen: "bg-slate-700 text-slate-50", print: "bg-slate-100 text-slate-900" },
  server: { screen: "bg-zinc-800 text-zinc-50", print: "bg-zinc-100 text-zinc-900" },
  access_point: { screen: "bg-slate-200 text-slate-900", print: "bg-white text-slate-900" },
  gateway: { screen: "bg-indigo-900 text-indigo-50", print: "bg-slate-100 text-slate-900" },
  patch_panel: { screen: "bg-slate-600 text-slate-50", print: "bg-slate-50 text-slate-900" },
  pdu: { screen: "bg-stone-700 text-stone-50", print: "bg-stone-100 text-stone-900" },
  ups: { screen: "bg-emerald-900 text-emerald-50", print: "bg-slate-100 text-slate-900" },
  shelf: { screen: "bg-slate-500 text-slate-50", print: "bg-slate-200 text-slate-900" },
  blank: { screen: "bg-slate-800 text-slate-300", print: "bg-white text-slate-600" },
  other: { screen: "bg-slate-600 text-slate-50", print: "bg-slate-100 text-slate-900" },
};

/** The decoration that makes a drawn face read as a switch, a patch panel ... (CSS only, so it costs nothing to print). */
function decoration(style: RackItemStyle, side: RackSide, print: boolean): CSSProperties | null {
  const ink = print ? "rgba(15,23,42,0.55)" : "rgba(255,255,255,0.5)";
  const faint = print ? "rgba(15,23,42,0.25)" : "rgba(255,255,255,0.22)";
  switch (style) {
    case "switch":
    case "gateway":
      return {
        backgroundImage: `linear-gradient(90deg, ${ink} 0 70%, transparent 70% 100%)`,
        backgroundSize: "9px 55%",
        backgroundRepeat: "repeat-x",
        backgroundPosition: "center",
      };
    case "patch_panel":
      return {
        backgroundImage: `radial-gradient(circle, ${ink} 0 28%, transparent 32%)`,
        backgroundSize: "11px 11px",
        backgroundRepeat: "repeat",
        backgroundPosition: "center",
      };
    case "server":
      return side === "front"
        ? { backgroundImage: `linear-gradient(90deg, ${ink} 0 80%, transparent 80% 100%)`, backgroundSize: "26px 60%", backgroundRepeat: "repeat-x", backgroundPosition: "center" }
        : { backgroundImage: `linear-gradient(90deg, ${faint} 0 90%, transparent 90% 100%)`, backgroundSize: "60px 70%", backgroundRepeat: "repeat-x", backgroundPosition: "center" };
    case "pdu":
      return {
        backgroundImage: `linear-gradient(90deg, ${ink} 0 55%, transparent 55% 100%)`,
        backgroundSize: "18px 45%",
        backgroundRepeat: "repeat-x",
        backgroundPosition: "center",
      };
    case "blank":
      return { backgroundImage: `repeating-linear-gradient(135deg, ${faint} 0 2px, transparent 2px 7px)` };
    case "ups":
      return { backgroundImage: `linear-gradient(${faint}, ${faint})`, backgroundSize: "28% 50%", backgroundRepeat: "no-repeat", backgroundPosition: "92% center" };
    default:
      return null;
  }
}

/** The name on a face; a device that has gone from its system says so rather than looking normal. */
function shownName(item: RackItemView): string {
  return item.live.missing ? `${item.live.name} (not found)` : item.live.name;
}

function GeneratedFace({ item, side, print }: { item: RackItemView; side: RackSide; print: boolean }) {
  const palette = FACE[item.style][print ? "print" : "screen"];
  const deco = decoration(item.style, side, print);
  const tall = item.heightU >= 2;
  const title = item.style === "blank" || item.style === "shelf" ? RACK_ITEM_STYLE_LABELS[item.style] : shownName(item);
  return (
    <div className={`relative flex h-full w-full items-center gap-2 overflow-hidden px-2 ${side === "rear" ? "flex-row-reverse text-right" : ""} ${palette}`}>
      {deco ? <div aria-hidden className="absolute inset-y-0 right-0 w-1/2 opacity-90" style={{ ...deco, ...(side === "rear" ? { right: "auto", left: 0 } : null) }} /> : null}
      {print ? null : (
        <span className={`relative z-[1] min-w-0 truncate text-[11px] font-medium leading-tight ${tall ? "text-xs" : ""}`}>
          {title}
          {side === "rear" ? <span className="ml-1 opacity-80">(rear)</span> : null}
        </span>
      )}
    </div>
  );
}

function PictureFace({ pic, heightU, print, name }: { pic: RackPicture; heightU: number; print: boolean; name: string }) {
  // Stretch a picture whose proportions are about the slot's; otherwise fit it inside so it is not distorted.
  const fill = pictureFitsSlot(pic.width, pic.height, heightU);
  return (
    <div className={`relative h-full w-full ${print ? "bg-white" : "bg-slate-900"}`}>
      {pic.modules.length > 0 ? (
        // Add-on modules sit at fractions of the switch's picture, so both are drawn in the picture's own box: the SVG
        // stretches or fits that box the way the plain picture would, and the modules stay on their bays.
        <svg
          aria-hidden
          viewBox={`0 0 ${pic.width} ${pic.height}`}
          preserveAspectRatio={fill ? "none" : "xMidYMid meet"}
          className="h-full w-full"
        >
          <image href={pic.url} x={0} y={0} width={pic.width} height={pic.height} preserveAspectRatio="none" />
          {pic.modules.map((m) => (
            <image
              key={m.id}
              href={m.url}
              x={m.x * pic.width}
              y={m.y * pic.height}
              width={m.w * pic.width}
              height={m.h * pic.height}
              preserveAspectRatio="none"
            />
          ))}
        </svg>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={pic.url} alt="" loading="lazy" className="h-full w-full" style={{ objectFit: fill ? "fill" : "contain" }} />
      )}
      {print ? null : (
        <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 max-w-[70%] truncate rounded bg-slate-950/75 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white">
          {name}
        </span>
      )}
    </div>
  );
}

export function RackElevation({ units, items, models, side, variant, pictures = true, selectedId, onSelect, onEmpty, label }: Props) {
  const print = variant === "print";
  const rows = drawnUnits(units, items);
  const rowOf = (u: number) => rows - u + 1; // grid rows run from the top; U runs from the bottom
  const taken = new Set<number>();
  for (const it of items) for (let u = it.startU; u <= topU(it); u++) taken.add(u);

  const rail = print ? "bg-slate-200 text-slate-800" : "bg-slate-900 text-slate-300";
  const gridStyle: CSSProperties = { gridTemplateColumns: "1.75rem minmax(0,1fr) 1.75rem", gridTemplateRows: `repeat(${rows}, var(--u))` };
  const nums = Array.from({ length: rows }, (_, i) => rows - i);

  return (
    <div
      role="group"
      aria-label={label}
      className={`rack-elevation grid overflow-hidden rounded-sm ${print ? "border border-slate-900" : "border-2 border-slate-900 bg-slate-950 dark:border-slate-700"}`}
      style={gridStyle}
    >
      {nums.map((u) => (
        <div
          key={`l${u}`}
          aria-hidden
          className={`flex items-center justify-center text-[10px] font-medium tabular-nums ${rail}`}
          style={{ gridColumn: 1, gridRow: rowOf(u) }}
        >
          {u}
        </div>
      ))}
      {nums.map((u) => (
        <div
          key={`r${u}`}
          aria-hidden
          className={`flex items-center justify-center text-[10px] font-medium tabular-nums ${rail}`}
          style={{ gridColumn: 3, gridRow: rowOf(u) }}
        >
          {u}
        </div>
      ))}

      {nums
        .filter((u) => !taken.has(u))
        .map((u) => {
          const cell: CSSProperties = { gridColumn: 2, gridRow: rowOf(u) };
          const cls = print
            ? "border-b border-dashed border-slate-300 bg-white"
            : "border-b border-slate-800 bg-slate-950";
          return onEmpty && !print ? (
            <button
              key={`e${u}`}
              type="button"
              onClick={() => onEmpty(u)}
              aria-label={`Add an item at U${u}`}
              className={`group flex items-center justify-center text-[10px] text-transparent hover:bg-slate-800 hover:text-slate-300 focus-visible:bg-slate-800 focus-visible:text-slate-200 ${cls}`}
              style={cell}
            >
              <span aria-hidden>+ U{u}</span>
            </button>
          ) : (
            <div key={`e${u}`} className={cls} style={cell} />
          );
        })}

      {items.map((item) => {
        const pic = !print || pictures ? rackItemPicture(item, models, side) : null;
        const cell: CSSProperties = { gridColumn: 2, gridRow: `${rowOf(topU(item))} / span ${item.heightU}` };
        const span = item.heightU > 1 ? `U${item.startU}-U${topU(item)}` : `U${item.startU}`;
        const face = pic ? (
          <PictureFace pic={pic} heightU={item.heightU} print={print} name={shownName(item)} />
        ) : (
          <GeneratedFace item={item} side={side} print={print} />
        );
        const frame = `border-b ${print ? "border-slate-900" : "border-slate-950"} overflow-hidden`;
        if (print || !onSelect) {
          return (
            <div key={item.id} className={frame} style={cell}>
              {face}
            </div>
          );
        }
        const selected = selectedId === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            aria-label={`${item.live.name}, ${span}${item.live.missing ? ", no longer found" : ""}. Edit`}
            aria-pressed={selected}
            title={`${item.live.name} (${span})`}
            className={`${frame} block text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-400 ${
              selected ? "outline outline-2 -outline-offset-2 outline-brand-400" : "hover:brightness-110"
            }`}
            style={cell}
          >
            {face}
          </button>
        );
      })}
    </div>
  );
}
