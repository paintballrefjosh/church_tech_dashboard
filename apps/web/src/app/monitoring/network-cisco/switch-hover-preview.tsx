"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { CiscoPortRow, CiscoSwitch, SwitchModel } from "@church/shared";
import { FacePreview, faceSummary } from "@/components/switch-faceplate";
import { resolveSwitchView } from "@/lib/faceplates/custom";
import { ciscoFaceItems } from "@/lib/faceplates/cisco-items";

/** How long a switch's ports, read for a hover card, are reused before they are read again. */
const PORTS_FRESH_MS = 30_000;
/** Gap between the pointer and the card, and the least room kept from the window's edges, in px. */
const OFFSET = 16;
const EDGE = 8;
const CARD_MAX_WIDTH = 560;

type Ports = { at: number; ports: CiscoPortRow[] | null };

/**
 * A card with the switch's picture, its ports coloured by state, that follows the mouse while it is over the switch's row in
 * the list. Mouse only: touch and the keyboard open the switch's page, which has the full view. A switch with no picture
 * (no matching profile, or the picture turned off) gets no card. Ports are read on the first hover and reused for
 * `PORTS_FRESH_MS`.
 */
export function useSwitchHoverPreview(models: SwitchModel[] | null) {
  const [hover, setHover] = useState<{ sw: CiscoSwitch; x: number; y: number } | null>(null);
  const cache = useRef(new Map<string, Ports>());
  const inflight = useRef(new Set<string>());
  const [, setVersion] = useState(0);
  const frame = useRef<number | null>(null);

  const read = useCallback((id: string) => {
    const hit = cache.current.get(id);
    if ((hit && Date.now() - hit.at < PORTS_FRESH_MS) || inflight.current.has(id)) return;
    inflight.current.add(id);
    fetch(`/api/cisco/switches/${id}/ports`, { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as CiscoPortRow[]) : null))
      .catch(() => null)
      .then((ports) => {
        cache.current.set(id, { at: Date.now(), ports });
        inflight.current.delete(id);
        setVersion((v) => v + 1);
      });
  }, []);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const rowProps = useCallback(
    (sw: CiscoSwitch) => ({
      onPointerEnter: (e: ReactPointerEvent) => {
        if (e.pointerType !== "mouse") return;
        read(sw.id);
        setHover({ sw, x: e.clientX, y: e.clientY });
      },
      onPointerMove: (e: ReactPointerEvent) => {
        if (e.pointerType !== "mouse") return;
        const { clientX: x, clientY: y } = e;
        // One position per frame, however fast the pointer moves.
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          setHover((h) => (h && h.sw.id === sw.id ? { ...h, x, y } : { sw, x, y }));
        });
      },
      onPointerLeave: () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        setHover((h) => (h && h.sw.id === sw.id ? null : h));
      },
    }),
    [read],
  );

  let card: React.ReactNode = null;
  if (hover && models) {
    const view = resolveSwitchView(models, { model: hover.sw.model, switchModelId: hover.sw.switchModelId, switchViewOff: hover.sw.switchViewOff });
    if (view.layout) {
      const entry = cache.current.get(hover.sw.id);
      card = <HoverCard x={hover.x} y={hover.y} sw={hover.sw} layout={view.layout} ports={entry ? entry.ports : undefined} />;
    }
  }
  return { rowProps, card };
}

function HoverCard({
  x,
  y,
  sw,
  layout,
  ports,
}: {
  x: number;
  y: number;
  sw: CiscoSwitch;
  layout: NonNullable<ReturnType<typeof resolveSwitchView>["layout"]>;
  /** undefined = still being read, null = could not be read. */
  ports: CiscoPortRow[] | null | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Beside the pointer, flipped to the other side when it would leave the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    let left = x + OFFSET;
    let top = y + OFFSET;
    if (left + width > window.innerWidth - EDGE) left = Math.max(EDGE, x - OFFSET - width);
    if (top + height > window.innerHeight - EDGE) top = Math.max(EDGE, y - OFFSET - height);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });
  const items = ports ? ciscoFaceItems(ports, layout) : [];
  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={ref}
      data-testid="switch-hover-preview"
      aria-hidden
      className="pointer-events-none fixed z-50 rounded-md border border-slate-300 bg-white p-2 shadow-xl dark:border-slate-700 dark:bg-slate-900"
      style={{ left: 0, top: 0, visibility: "hidden", width: `min(${CARD_MAX_WIDTH}px, calc(100vw - ${EDGE * 2}px))` }}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2 px-0.5 text-xs">
        <span className="font-semibold text-slate-800 dark:text-slate-100">{sw.hostname}</span>
        <span className="truncate text-slate-500 dark:text-slate-400">{layout.title}</span>
      </div>
      <FacePreview layout={layout} items={items} />
      <p className="mt-1.5 px-0.5 text-xs text-slate-600 dark:text-slate-400">
        {ports === undefined ? "Reading ports…" : ports === null ? "The ports could not be read." : faceSummary(items) || "No ports on the picture."}
      </p>
    </div>,
    document.body,
  );
}
