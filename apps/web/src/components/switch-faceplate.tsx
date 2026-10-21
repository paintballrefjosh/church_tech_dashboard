"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FlipHorizontal2 } from "lucide-react";
import type { FaceplateLayout } from "@/lib/faceplates/layouts";

export type FaceState = "up" | "down" | "shut" | "error" | "unknown";

/** One port of the device, however the page got it (a Cisco row, a UniFi port). */
export interface FaceItem {
  id: string;
  /** The faceplate slot it sits on (`FaceplatePortSpec.key`), or null to list it below the picture. */
  slot: string | null;
  /** "Gi1/0/7" */
  label: string;
  state: FaceState;
  /** In words, for people who cannot tell the colours apart: "up", "shut down", "error-disabled". */
  stateText: string;
}

const STATE_COLOUR: Record<FaceState, { ring: string; fill: string }> = {
  up: { ring: "#34d399", fill: "rgba(52, 211, 153, 0.45)" },
  down: { ring: "#fbbf24", fill: "rgba(251, 191, 36, 0.30)" },
  shut: { ring: "#94a3b8", fill: "rgba(15, 23, 42, 0.55)" },
  error: { ring: "#fb7185", fill: "rgba(251, 113, 133, 0.55)" },
  unknown: { ring: "#64748b", fill: "rgba(100, 116, 139, 0.20)" },
};

export const FACE_LEGEND: Array<{ state: FaceState; label: string }> = [
  { state: "up", label: "Up" },
  { state: "down", label: "Enabled, no link" },
  { state: "shut", label: "Shut down" },
  { state: "error", label: "Error-disabled" },
  { state: "unknown", label: "Not read yet" },
];

function ringStyle(state: FaceState): CSSProperties {
  const c = STATE_COLOUR[state];
  return { borderColor: c.ring, backgroundColor: c.fill, borderStyle: state === "unknown" ? "dashed" : "solid" };
}

export function FaceLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400" aria-label="Port colours">
      {FACE_LEGEND.map((l) => (
        <li key={l.state} className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-sm border-2" style={ringStyle(l.state)} aria-hidden />
          {l.label}
        </li>
      ))}
    </ul>
  );
}

const CLOSE_DELAY_MS = 220;
/** Moving from a port to its popover crosses neighbouring ports; one only takes over the popover if the pointer rests. */
const SWITCH_DELAY_MS = 140;
const POPOVER_GAP = 8;

interface Anchor {
  id: string;
  rect: DOMRect;
}

/**
 * A device seen from the front: its photo (or a drawn chassis when there is none) with a button over every port.
 * Hovering or focusing a port previews `renderDetails`; clicking it, or pressing Enter, pins that popover so its
 * buttons can be reached. Ports with no place on the front are listed in a strip under the picture and behave alike.
 */
export function SwitchFaceplate({
  layout,
  items,
  renderDetails,
}: {
  layout: FaceplateLayout;
  items: FaceItem[];
  /** Popover body for a port; call `close` after an action that should dismiss it. */
  renderDetails: (id: string, close: () => void) => ReactNode;
}) {
  const [hover, setHover] = useState<Anchor | null>(null);
  const [pinned, setPinned] = useState<Anchor | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const other = layout.otherImage;
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttons = useRef(new Map<string, HTMLElement>());
  const restoringFocus = useRef(false);
  const popoverId = useRef(`faceplate-popover-${Math.random().toString(36).slice(2, 9)}`).current;

  const open = pinned ?? hover;
  const bySlot = new Map(items.filter((i) => i.slot !== null).map((i) => [i.slot as string, i]));
  const strip = items.filter((i) => i.slot === null || !layout.ports.some((p) => p.key === i.slot));
  const photo = layout.image && !imageFailed ? layout.image : null;
  // An add-on module shows only while the device reports one of its ports, so a switch without the module is drawn as it is.
  const activeGroups = new Set(layout.ports.filter((p) => p.group && bySlot.has(p.key)).map((p) => p.group as string));
  const shownPorts = layout.ports.filter((p) => !p.group || activeGroups.has(p.group));
  const shownOverlays = (layout.overlays ?? []).filter((o) => activeGroups.has(o.id));

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHover(null), CLOSE_DELAY_MS);
  }, [cancelClose]);
  const closeAll = useCallback(() => {
    cancelClose();
    setHover(null);
    setPinned(null);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  function anchorOf(id: string, el: HTMLElement): Anchor {
    return { id, rect: el.getBoundingClientRect() };
  }
  function previewOn(id: string, el: HTMLElement) {
    cancelClose();
    if (open && open.id !== id) {
      closeTimer.current = setTimeout(() => setHover(anchorOf(id, el)), SWITCH_DELAY_MS);
      return;
    }
    setHover(anchorOf(id, el));
  }
  function pinOn(id: string, el: HTMLElement) {
    cancelClose();
    setPinned((cur) => (cur?.id === id ? null : anchorOf(id, el)));
  }

  // A pinned popover closes on Escape (focus goes back to its port) or a press anywhere else.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      const id = open?.id;
      closeAll();
      if (id) {
        // Giving the port its focus back must not open its preview again.
        restoringFocus.current = true;
        buttons.current.get(id)?.focus();
        restoringFocus.current = false;
      }
    }
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      const pop = document.getElementById(popoverId);
      if (pop?.contains(t)) return;
      for (const b of buttons.current.values()) if (b.contains(t)) return;
      closeAll();
    }
    function onMove() {
      const el = open ? buttons.current.get(open.id) : null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setHover((h) => (h ? { ...h, rect } : h));
      setPinned((p) => (p ? { ...p, rect } : p));
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, closeAll, popoverId]);

  function portButton(item: FaceItem, style: CSSProperties | undefined, className: string, children?: ReactNode) {
    const isOpen = open?.id === item.id;
    return (
      <button
        key={item.id}
        type="button"
        ref={(el) => {
          if (el) buttons.current.set(item.id, el);
          else buttons.current.delete(item.id);
        }}
        data-port={item.label}
        data-state={item.state}
        aria-label={`${item.label}, ${item.stateText}`}
        aria-expanded={isOpen}
        aria-controls={isOpen ? popoverId : undefined}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") previewOn(item.id, e.currentTarget);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") scheduleClose();
        }}
        onFocus={(e) => {
          if (!restoringFocus.current) previewOn(item.id, e.currentTarget);
        }}
        onBlur={scheduleClose}
        onClick={(e) => pinOn(item.id, e.currentTarget)}
        style={style}
        className={className}
      >
        {children}
      </button>
    );
  }

  const openItem = open ? items.find((i) => i.id === open.id) : undefined;

  return (
    <div className="space-y-3">
      {flipped && other ? (
        <div tabIndex={0} role="region" aria-label={`${layout.title}, ${other.side}`} className="overflow-x-auto rounded-md border border-slate-300 bg-slate-100 p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="relative mx-auto" style={{ aspectRatio: `${other.width} / ${other.height}`, minWidth: 760, maxWidth: 1400 }}>
            {/* eslint-disable-next-line @next/next/no-img-element -- the admin's own picture */}
            <img src={other.url} alt={`${layout.title}, ${other.side}`} className="absolute inset-0 h-full w-full select-none" draggable={false} />
          </div>
        </div>
      ) : (
      <div tabIndex={0} role="region" aria-label={`${layout.title}, ports`} className="overflow-x-auto rounded-md border border-slate-300 bg-slate-100 p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="relative mx-auto" style={{ aspectRatio: `${layout.width} / ${layout.height}`, minWidth: 760, maxWidth: 1400 }}>
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- a fixed catalogue photo, sized by the layout
            <img src={photo} alt={layout.title} onError={() => setImageFailed(true)} className="absolute inset-0 h-full w-full select-none" draggable={false} />
          ) : (
            <DrawnChassis layout={layout} ports={shownPorts} />
          )}
          {shownOverlays.map((o) => (
            // eslint-disable-next-line @next/next/no-img-element -- the admin's own picture of the module
            <img
              key={o.id}
              src={o.url}
              alt={o.label}
              draggable={false}
              className="absolute select-none"
              style={{ left: `${(o.x / layout.width) * 100}%`, top: `${(o.y / layout.height) * 100}%`, width: `${(o.w / layout.width) * 100}%`, height: `${(o.h / layout.height) * 100}%` }}
            />
          ))}
          {shownPorts.map((spec) => {
            const item = bySlot.get(spec.key);
            const pos: CSSProperties = {
              left: `${(spec.x / layout.width) * 100}%`,
              top: `${(spec.y / layout.height) * 100}%`,
              width: `${(spec.w / layout.width) * 100}%`,
              height: `${(spec.h / layout.height) * 100}%`,
            };
            if (!item) {
              // A socket on the panel that the device has no row for: drawn, not interactive.
              return <span key={spec.key} aria-hidden className="absolute rounded-[2px] border border-dashed border-slate-500/60" style={pos} />;
            }
            return portButton(item, { ...pos, ...ringStyle(item.state) }, "absolute rounded-[2px] border-2 outline-offset-2 transition-transform hover:z-10 hover:scale-110 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white");
          })}
        </div>
      </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <FaceLegend />
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2">
          {!layout.calibrated ? <span className="text-xs text-slate-500 dark:text-slate-400">Port positions on this model are approximate.</span> : null}
          {other ? (
            <button
              type="button"
              aria-pressed={flipped}
              onClick={() => {
                closeAll();
                setFlipped((f) => !f);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <FlipHorizontal2 className="h-3.5 w-3.5" aria-hidden /> {flipped ? "Back to the ports" : `Show the ${other.side}`}
            </button>
          ) : null}
        </div>
      </div>

      {strip.length > 0 ? (
        <section aria-label="Other interfaces" className="space-y-1.5">
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Other interfaces</h3>
          <div className="flex flex-wrap gap-1.5">
            {strip.map((item) =>
              portButton(
                item,
                ringStyle(item.state),
                "rounded-md border-2 px-2 py-1 font-mono text-xs text-slate-900 outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 dark:text-slate-100",
                item.label,
              ),
            )}
          </div>
        </section>
      ) : null}

      {open && openItem ? (
        <Popover key={openItem.id} id={popoverId} anchor={open.rect} pinned={Boolean(pinned)} label={`${openItem.label} details`} onEnter={cancelClose} onLeave={scheduleClose}>
          {renderDetails(openItem.id, closeAll)}
        </Popover>
      ) : null}
    </div>
  );
}

/** The panel when there is no photo: a dark chassis with rack ears, under the port buttons. */
function DrawnChassis({ layout, ports }: { layout: FaceplateLayout; ports: FaceplateLayout["ports"] }) {
  const ear = (14 / layout.width) * 100;
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden rounded-[3px] bg-gradient-to-b from-slate-600 to-slate-800 shadow-inner">
      <div className="absolute inset-y-0 left-0 bg-slate-700" style={{ width: `${ear}%` }} />
      <div className="absolute inset-y-0 right-0 bg-slate-700" style={{ width: `${ear}%` }} />
      {ports.map((p) => (
        <span
          key={p.key}
          className="absolute rounded-[2px] bg-slate-950 shadow-[inset_0_1px_2px_rgba(0,0,0,0.9)]"
          style={{ left: `${(p.x / layout.width) * 100}%`, top: `${(p.y / layout.height) * 100}%`, width: `${(p.w / layout.width) * 100}%`, height: `${(p.h / layout.height) * 100}%` }}
        />
      ))}
    </div>
  );
}

/** Floats above (or below, when there is no room) the port it describes; stays while the pointer is on it. */
function Popover({
  id,
  anchor,
  pinned,
  label,
  onEnter,
  onLeave,
  children,
}: {
  id: string;
  anchor: DOMRect;
  pinned: boolean;
  label: string;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const margin = 8;
    let left = anchor.left + anchor.width / 2 - w / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
    let top = anchor.top - h - POPOVER_GAP;
    if (top < margin) top = anchor.bottom + POPOVER_GAP;
    setPos({ left, top });
  }, [anchor, children]);

  // Pinned by keyboard or touch: move focus in so its buttons are reachable (it sits at the end of the page).
  const focused = useRef(false);
  useEffect(() => {
    if (!pinned || focused.current) return;
    focused.current = true;
    ref.current?.querySelector<HTMLElement>("button, a, input, select")?.focus();
  }, [pinned]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-label={label}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{ position: "fixed", left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? "visible" : "hidden" }}
      className="z-50 w-72 rounded-md border border-slate-300 bg-white p-3 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-900"
    >
      {children}
    </div>,
    document.body,
  );
}
