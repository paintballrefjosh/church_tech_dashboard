"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { BoxSelect, Plus, Redo2, Trash2, Undo2, Wand2, ZoomIn } from "lucide-react";
import type { SwitchPortKind } from "@church/shared";
import {
  duplicateNames,
  intersects,
  matchSize,
  moveBoxes,
  newPort,
  rectFrom,
  resizeBoxes,
  type EditorPort,
  type Frac,
} from "@/lib/faceplates/editor-ops";
import { PortAutoLayoutPanel, type Ghost } from "./port-autolayout-panel";

type Drag =
  | { mode: "move" | "resize"; startX: number; startY: number; base: EditorPort[]; sel: Set<string>; moved: boolean }
  | { mode: "marquee" | "area"; startX: number; startY: number; baseSel: Set<string>; moved: boolean };

const btn =
  "inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800";
const field = "rounded-md border border-slate-300 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-950";

/** Applies on blur or Enter, so typing a name is one undo step, not one per letter. */
function CommitInput({ value, onCommit, label, mono }: { value: string; onCommit: (v: string) => void; label: string; mono?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      className={`w-full ${field} ${mono ? "font-mono" : ""}`}
    />
  );
}

/**
 * Where the ports are on the picture: boxes the admin drags, resizes, names and adds. The boxes live in `ports` (the
 * parent keeps them and the undo history); this holds only what is happening right now (the selection, a drag under way).
 * Auto placement proposes boxes as ghosts first and adds them only when asked.
 */
export function PortLayoutEditor({
  imageUrl,
  imageWidth,
  imageHeight,
  ports,
  onChange,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  readOnly = false,
}: {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  ports: EditorPort[];
  onChange: (next: EditorPort[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  readOnly?: boolean;
}) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<EditorPort[] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [tool, setTool] = useState<"select" | "area">("select");
  const [area, setArea] = useState<Frac | null>(null);
  const [rubber, setRubber] = useState<Frac | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [autoOpen, setAutoOpen] = useState(false);
  const helpId = useId();

  const boxRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const live = useRef({ draft: null as EditorPort[] | null, rubber: null as Frac | null, ports, onChange });
  live.current.ports = ports;
  live.current.onChange = onChange;

  const shown = draft ?? ports;
  const dups = useMemo(() => duplicateNames(shown), [shown]);
  const selectedPorts = useMemo(() => shown.filter((p) => sel.has(p.uid)), [shown, sel]);
  const ratio = imageWidth / imageHeight;

  // Forget selected boxes that no longer exist (undo, delete, replace).
  useEffect(() => {
    setSel((cur) => {
      const ids = new Set(ports.map((p) => p.uid));
      const next = new Set([...cur].filter((u) => ids.has(u)));
      return next.size === cur.size ? cur : next;
    });
  }, [ports]);

  const toFrac = useCallback((clientX: number, clientY: number) => {
    const r = boxRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return { x: 0, y: 0, rw: 1, rh: 1 };
    return { x: (clientX - r.left) / r.width, y: (clientY - r.top) / r.height, rw: r.width, rh: r.height };
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current;
      if (!d) return;
      const f = toFrac(e.clientX, e.clientY);
      const dx = f.x - d.startX;
      const dy = f.y - d.startY;
      if (!d.moved && Math.abs(dx) * f.rw + Math.abs(dy) * f.rh < 3) return;
      d.moved = true;
      if (d.mode === "move" || d.mode === "resize") {
        const next = d.mode === "move" ? moveBoxes(d.base, d.sel, dx, dy) : resizeBoxes(d.base, d.sel, dx, dy);
        live.current.draft = next;
        setDraft(next);
      } else {
        const rect = rectFrom(Math.max(0, Math.min(1, d.startX)), Math.max(0, Math.min(1, d.startY)), Math.max(0, Math.min(1, f.x)), Math.max(0, Math.min(1, f.y)));
        live.current.rubber = rect;
        setRubber(rect);
        if (d.mode === "marquee") {
          const hit = live.current.ports.filter((p) => intersects(rect, p)).map((p) => p.uid);
          setSel(new Set([...d.baseSel, ...hit]));
        }
      }
    }
    function onUp() {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      if (d.mode === "move" || d.mode === "resize") {
        const out = live.current.draft;
        live.current.draft = null;
        setDraft(null);
        if (d.moved && out) live.current.onChange(out);
      } else {
        const rect = live.current.rubber;
        live.current.rubber = null;
        setRubber(null);
        if (d.mode === "area") {
          if (d.moved && rect && rect.w > 0.004 && rect.h > 0.004) setArea(rect);
          setTool("select");
        }
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [toFrac]);

  function onPointerDown(e: React.PointerEvent) {
    if (readOnly || e.button !== 0) return;
    const target = e.target as HTMLElement;
    const uid = target.closest<HTMLElement>("[data-uid]")?.dataset.uid;
    const handle = target.closest("[data-handle]") !== null;
    const f = toFrac(e.clientX, e.clientY);
    boxRef.current?.focus();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;

    if (tool === "area") {
      e.preventDefault();
      drag.current = { mode: "area", startX: f.x, startY: f.y, baseSel: new Set(), moved: false };
      return;
    }
    if (uid) {
      e.preventDefault();
      let next = sel;
      if (additive && !handle) {
        next = new Set(sel);
        if (next.has(uid)) next.delete(uid);
        else next.add(uid);
        setSel(next);
        if (!next.has(uid)) return;
      } else if (!sel.has(uid)) {
        next = new Set([uid]);
        setSel(next);
      }
      drag.current = { mode: handle ? "resize" : "move", startX: f.x, startY: f.y, base: live.current.ports, sel: next, moved: false };
      return;
    }
    e.preventDefault();
    const baseSel = additive ? new Set(sel) : new Set<string>();
    if (!additive) setSel(baseSel);
    drag.current = { mode: "marquee", startX: f.x, startY: f.y, baseSel, moved: false };
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (readOnly) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) onRedo();
      else onUndo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      onRedo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSel(new Set(ports.map((p) => p.uid)));
    } else if ((e.key === "Delete" || e.key === "Backspace") && sel.size > 0) {
      e.preventDefault();
      removeSelected();
    } else if (e.key === "Escape") {
      setSel(new Set());
      setTool("select");
    } else if (e.key.startsWith("Arrow") && sel.size > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      onChange(moveBoxes(ports, sel, dx / imageWidth, dy / imageHeight));
    }
  }

  function removeSelected() {
    onChange(ports.filter((p) => !sel.has(p.uid)));
    setSel(new Set());
  }

  function addPort() {
    const scroller = scrollRef.current;
    const box = boxRef.current;
    const x = scroller && box ? (scroller.scrollLeft + scroller.clientWidth / 2) / box.offsetWidth : 0.5;
    const p = newPort(ports, "rj45", { x, y: 0.5 });
    onChange([...ports, p]);
    setSel(new Set([p.uid]));
  }

  function update(uid: string, patch: Partial<EditorPort>) {
    onChange(ports.map((p) => (p.uid === uid ? { ...p, ...patch } : p)));
  }

  function setKindForSelected(kind: SwitchPortKind) {
    onChange(ports.map((p) => (sel.has(p.uid) ? { ...p, kind } : p)));
  }

  const one = selectedPorts.length === 1 ? selectedPorts[0]! : null;
  const pct = (n: number) => `${n * 100}%`;
  const boxStyle = (b: Frac) => ({ left: pct(b.x), top: pct(b.y), width: pct(b.w), height: pct(b.h) });

  return (
    <div className="space-y-3">
      {!readOnly ? (
        <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Port layout tools">
          <button type="button" className={btn} onClick={onUndo} disabled={!canUndo} aria-label="Undo">
            <Undo2 className="h-3.5 w-3.5" aria-hidden /> Undo
          </button>
          <button type="button" className={btn} onClick={onRedo} disabled={!canRedo} aria-label="Redo">
            <Redo2 className="h-3.5 w-3.5" aria-hidden /> Redo
          </button>
          <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-700" aria-hidden />
          <button type="button" className={btn} onClick={addPort}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add port
          </button>
          <button type="button" className={`${btn} text-rose-700 dark:text-rose-300`} onClick={removeSelected} disabled={sel.size === 0}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Delete{sel.size > 1 ? ` ${sel.size}` : ""}
          </button>
          <button type="button" className={btn} onClick={() => setSel(new Set(ports.map((p) => p.uid)))} disabled={ports.length === 0}>
            Select all
          </button>
          <button
            type="button"
            className={btn}
            disabled={sel.size < 2}
            onClick={() => selectedPorts[0] && onChange(matchSize(ports, sel, selectedPorts[0].uid))}
            title="Give every selected box the size of the first one selected"
          >
            Same size
          </button>
          <span className="mx-1 h-5 w-px bg-slate-300 dark:bg-slate-700" aria-hidden />
          <button type="button" className={`${btn} ${tool === "area" ? "border-amber-400 bg-amber-50 dark:bg-amber-900/20" : ""}`} aria-pressed={tool === "area"} onClick={() => setTool((t) => (t === "area" ? "select" : "area"))}>
            <BoxSelect className="h-3.5 w-3.5" aria-hidden /> {area ? "Redraw area" : "Select area"}
          </button>
          <button type="button" className={`${btn} border-brand-400 text-brand-700 dark:text-brand-300`} aria-expanded={autoOpen} onClick={() => setAutoOpen((o) => !o)}>
            <Wand2 className="h-3.5 w-3.5" aria-hidden /> Auto
          </button>
          <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <ZoomIn className="h-3.5 w-3.5" aria-hidden />
            Zoom
            <input type="range" min={1} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
          </label>
        </div>
      ) : (
        <label className="flex items-center justify-end gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <ZoomIn className="h-3.5 w-3.5" aria-hidden />
          Zoom
          <input type="range" min={1} max={4} step={0.25} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Zoom" />
        </label>
      )}

      {autoOpen && !readOnly ? (
        <PortAutoLayoutPanel
          imageUrl={imageUrl}
          area={area}
          onClearArea={() => setArea(null)}
          ports={ports}
          selected={selectedPorts}
          onGhosts={setGhosts}
          onApply={(next) => {
            onChange(next);
            setSel(new Set());
          }}
          onClose={() => setAutoOpen(false)}
        />
      ) : null}

      <div ref={scrollRef} className="overflow-x-auto rounded-md border border-slate-300 bg-slate-100 p-2 dark:border-slate-800 dark:bg-slate-900">
        <div
          ref={boxRef}
          role="group"
          aria-label="Port layout"
          aria-describedby={helpId}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
          className={`relative touch-none select-none outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 ${tool === "area" ? "cursor-crosshair" : ""}`}
          style={{ width: `${zoom * 100}%`, aspectRatio: String(ratio) }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- the admin's own picture, laid out by its proportions */}
          <img src={imageUrl} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />

          {area ? <div aria-hidden className="pointer-events-none absolute border-2 border-dashed border-amber-400 bg-amber-300/10" style={boxStyle(area)} /> : null}

          {shown.map((p) => {
            const selected = sel.has(p.uid);
            const dup = [p.name, ...p.aliases].some((n) => dups.has(n.trim().toLowerCase()));
            return (
              <div
                key={p.uid}
                data-uid={p.uid}
                data-port={p.name}
                title={p.name}
                className={`group absolute rounded-[2px] border-2 ${readOnly ? "" : "cursor-move"} ${
                  dup ? "border-rose-500 bg-rose-500/30" : selected ? "z-10 border-amber-300 bg-amber-300/30" : "border-sky-400 bg-sky-400/20 hover:bg-sky-400/40"
                }`}
                style={boxStyle(p)}
              >
                <span className={`pointer-events-none absolute -top-5 left-0 z-20 whitespace-nowrap rounded bg-slate-900/90 px-1 font-mono text-[10px] text-white ${selected ? "block" : "hidden group-hover:block"}`}>
                  {p.name}
                </span>
                {selected && !readOnly ? <span data-handle aria-hidden className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-amber-400" /> : null}
              </div>
            );
          })}

          {ghosts.map((g, i) => (
            <div key={i} aria-hidden title={g.name} className="pointer-events-none absolute rounded-[2px] border-2 border-dashed border-emerald-400 bg-emerald-400/15" style={boxStyle(g.box)} />
          ))}

          {rubber ? <div aria-hidden className={`pointer-events-none absolute border ${tool === "area" ? "border-amber-400 bg-amber-300/20" : "border-sky-300 bg-sky-300/20"}`} style={boxStyle(rubber)} /> : null}
        </div>
      </div>

      {!readOnly ? (
        <p id={helpId} className="text-xs text-slate-500 dark:text-slate-400">
          Drag a box to move it and the square on its corner to resize it. Drag on empty space to select several (Shift-click adds one). With boxes selected the arrow keys nudge them (Shift for ten pixels at a time), Delete removes them, and Ctrl+Z undoes.
        </p>
      ) : (
        <p id={helpId} className="sr-only">Port layout, read only.</p>
      )}

      {!readOnly ? (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-2 rounded-md border border-slate-300 p-3 text-xs dark:border-slate-800">
            <h3 className="font-medium">{one ? "Selected port" : sel.size > 1 ? `${sel.size} ports selected` : "No port selected"}</h3>
            {one ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">Name</span>
                  <div className="mt-1"><CommitInput key={`n-${one.uid}`} label="Port name" mono value={one.name} onCommit={(v) => v.trim() && update(one.uid, { name: v.trim() })} /></div>
                </label>
                <label className="block">
                  <span className="text-slate-500 dark:text-slate-400">Other names (comma separated)</span>
                  <div className="mt-1">
                    <CommitInput
                      key={`a-${one.uid}`}
                      label="Other names for this port"
                      mono
                      value={one.aliases.join(", ")}
                      onCommit={(v) => update(one.uid, { aliases: v.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 4) })}
                    />
                  </div>
                </label>
              </div>
            ) : null}
            {sel.size > 0 ? (
              <label className="block">
                <span className="text-slate-500 dark:text-slate-400">Kind</span>
                <select value={one?.kind ?? ""} onChange={(e) => setKindForSelected(e.target.value as SwitchPortKind)} className={`mt-1 block ${field}`}>
                  {!one ? <option value="" disabled>Set for all…</option> : null}
                  <option value="rj45">RJ45</option>
                  <option value="sfp">SFP / SFP+</option>
                  <option value="qsfp">QSFP</option>
                  <option value="other">Other</option>
                </select>
              </label>
            ) : (
              <p className="text-slate-500 dark:text-slate-400">Click a box (or a port in the list) to rename it or change its kind.</p>
            )}
            {sel.size > 1 ? (
              <button type="button" className={btn} onClick={() => setAutoOpen(true)}>
                <Wand2 className="h-3.5 w-3.5" aria-hidden /> Rename these in order…
              </button>
            ) : null}
            {dups.size > 0 ? <p role="alert" className="text-rose-700 dark:text-rose-300">Some ports share a name (outlined in red). Each name can be on one port only.</p> : null}
          </div>

          <div className="rounded-md border border-slate-300 p-3 text-xs dark:border-slate-800">
            <h3 className="mb-2 font-medium">Ports ({ports.length})</h3>
            {ports.length === 0 ? (
              <p className="text-slate-500 dark:text-slate-400">None yet. Use Auto, or Add port.</p>
            ) : (
              <ul className="flex max-h-40 flex-wrap gap-1 overflow-auto" aria-label="Ports">
                {ports.map((p) => (
                  <li key={p.uid}>
                    <button
                      type="button"
                      aria-pressed={sel.has(p.uid)}
                      onClick={(e) => setSel((cur) => (e.shiftKey ? new Set(cur.has(p.uid) ? [...cur].filter((u) => u !== p.uid) : [...cur, p.uid]) : new Set([p.uid])))}
                      className={`rounded border px-1.5 py-0.5 font-mono ${sel.has(p.uid) ? "border-amber-400 bg-amber-100 text-slate-900 dark:bg-amber-900/40 dark:text-amber-100" : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"} ${dups.has(p.name.toLowerCase()) ? "border-rose-500" : ""}`}
                    >
                      {p.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
