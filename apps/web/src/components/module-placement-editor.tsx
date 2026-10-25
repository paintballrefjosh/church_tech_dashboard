"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { SwitchModel, SwitchModelModule } from "@church/shared";
import { switchModelImageUrl } from "@/lib/faceplates/custom";
import { defaultPlacement, moduleSize, moveTo, nudge, resizeTo, type Size } from "@/lib/faceplates/module-ops";

const field =
  "rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100";

/**
 * Where each add-on module sits on a switch model's picture. A box per module, dragged (or moved with the arrow keys, or
 * typed in below) over the picture, with the module's own picture inside it; the module's ports follow it. The box keeps
 * the module picture's proportions, so only its width is set.
 */
export function ModulePlacementEditor({
  host,
  hostImageUrl,
  hostSize,
  placements,
  catalogue,
  onChange,
  readOnly,
  base: MODELS,
}: {
  host: SwitchModel;
  hostImageUrl: string;
  hostSize: Size;
  placements: SwitchModelModule[];
  /** Every add-on module that exists (a module with no picture is listed but cannot be added yet). */
  catalogue: SwitchModel[];
  onChange: (next: SwitchModelModule[]) => void;
  readOnly: boolean;
  /** The models page this editor was opened from, so links stay in that section. */
  base: string;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; mode: "move" | "resize"; dx: number; dy: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pick, setPick] = useState("");

  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const addable = catalogue.filter((m) => moduleSize(m) !== null);
  const chosen = byId.get(pick) ?? addable[0];

  function replace(id: string, next: SwitchModelModule) {
    onChange(placements.map((p) => (p.id === id ? next : p)));
  }
  function sizeOf(p: SwitchModelModule): Size | null {
    const m = byId.get(p.moduleId);
    return m ? moduleSize(m) : null;
  }

  function add() {
    if (!chosen) return;
    const size = moduleSize(chosen);
    if (!size) return;
    const next = defaultPlacement(chosen.id, placements, hostSize, size);
    onChange([...placements, next]);
    setSelected(next.id);
  }

  function fractionAt(e: React.PointerEvent): { fx: number; fy: number } {
    const r = stage.current!.getBoundingClientRect();
    return { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
  }

  function onDown(e: React.PointerEvent, p: SwitchModelModule, mode: "move" | "resize") {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { fx, fy } = fractionAt(e);
    drag.current = { id: p.id, mode, dx: fx - p.x, dy: fy - p.y };
    setSelected(p.id);
  }
  function onMove(e: React.PointerEvent, p: SwitchModelModule) {
    const d = drag.current;
    const size = sizeOf(p);
    if (!d || d.id !== p.id || !size) return;
    const { fx, fy } = fractionAt(e);
    if (d.mode === "move") replace(p.id, moveTo(p, fx - d.dx, fy - d.dy, hostSize, size));
    else replace(p.id, resizeTo(p, fx - p.x, hostSize, size));
  }
  function onUp() {
    drag.current = null;
  }

  function onKey(e: React.KeyboardEvent, p: SwitchModelModule) {
    const size = sizeOf(p);
    if (readOnly || !size) return;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const a = arrows[e.key];
    if (a) {
      e.preventDefault();
      replace(p.id, nudge(p, a[0], a[1], e.shiftKey, hostSize, size));
    } else if (e.key === "+" || e.key === "=" || e.key === "-") {
      e.preventDefault();
      replace(p.id, resizeTo(p, p.w + (e.key === "-" ? -0.005 : 0.005), hostSize, size));
    } else if ((e.key === "Delete" || e.key === "Backspace") && !e.repeat) {
      e.preventDefault();
      onChange(placements.filter((x) => x.id !== p.id));
    }
  }

  function setPercent(p: SwitchModelModule, key: "x" | "y" | "w", text: string) {
    const size = sizeOf(p);
    const v = Number(text);
    if (!size || !Number.isFinite(v)) return;
    if (key === "w") replace(p.id, resizeTo(p, v / 100, hostSize, size));
    else replace(p.id, moveTo(p, key === "x" ? v / 100 : p.x, key === "y" ? v / 100 : p.y, hostSize, size));
  }

  return (
    <div className="space-y-3">
      {!readOnly ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="block text-xs text-slate-600 dark:text-slate-400">
            Add-on module
            <select value={chosen?.id ?? ""} onChange={(e) => setPick(e.target.value)} disabled={addable.length === 0} className={`mt-0.5 block min-w-56 ${field}`}>
              {addable.length === 0 ? <option value="">No add-on modules with a picture yet</option> : null}
              {addable.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!chosen || placements.length >= 8}
            onClick={add}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Add to {host.name}
          </button>
          <Link href={MODELS} className="text-xs text-brand-600 hover:underline dark:text-brand-400">
            Create or import a module on the Switch models page
          </Link>
        </div>
      ) : null}

      {placements.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No modules on this switch model. A module is drawn on a switch's page only when that switch reports one of its ports.
        </p>
      ) : (
        <>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Drag a module to where it plugs in, or select it and use the arrow keys (Shift for bigger steps) and + / - to size it. Its ports move with it.
          </p>
          <div className="overflow-x-auto rounded-md border border-slate-300 bg-slate-100 p-3 dark:border-slate-800 dark:bg-slate-900">
            <div ref={stage} className="relative mx-auto select-none" style={{ aspectRatio: `${hostSize.w} / ${hostSize.h}`, minWidth: 760, maxWidth: 1400 }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the admin's own picture */}
              <img src={hostImageUrl} alt="" draggable={false} className="absolute inset-0 h-full w-full" />
              {placements.map((p) => {
                const m = byId.get(p.moduleId);
                const imageId = m ? (m.portSide === "front" ? m.frontImageId : m.backImageId) : null;
                const on = selected === p.id;
                return (
                  <div
                    key={p.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${m?.name ?? "Missing module"}, ${Math.round(p.x * 100)} percent across, ${Math.round(p.y * 100)} percent down`}
                    aria-pressed={on}
                    onFocus={() => setSelected(p.id)}
                    onKeyDown={(e) => onKey(e, p)}
                    onPointerDown={(e) => onDown(e, p, "move")}
                    onPointerMove={(e) => onMove(e, p)}
                    onPointerUp={onUp}
                    onPointerCancel={onUp}
                    className={`absolute touch-none outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 ${readOnly ? "" : "cursor-move"} ${on ? "ring-2 ring-brand-500" : "ring-1 ring-sky-500"}`}
                    style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%`, width: `${p.w * 100}%`, height: `${p.h * 100}%` }}
                  >
                    {m && imageId ? (
                      // eslint-disable-next-line @next/next/no-img-element -- the admin's own picture of the module
                      <img src={switchModelImageUrl(m.id, m.portSide, imageId)} alt="" draggable={false} className="h-full w-full opacity-80" />
                    ) : null}
                    {!readOnly ? (
                      <span
                        aria-hidden
                        onPointerDown={(e) => onDown(e, p, "resize")}
                        onPointerMove={(e) => onMove(e, p)}
                        onPointerUp={onUp}
                        onPointerCancel={onUp}
                        className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-brand-600"
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          <ul className="space-y-1.5" aria-label="Modules on this switch model">
            {placements.map((p) => {
              const m = byId.get(p.moduleId);
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-800">
                  <span className="min-w-40 font-medium">
                    {m ? m.name : "A module that no longer exists"}
                    {m && m.ports.length === 0 ? <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-300">no ports marked yet</span> : null}
                  </span>
                  {(
                    [
                      ["x", "Across", p.x],
                      ["y", "Down", p.y],
                      ["w", "Width", p.w],
                    ] as const
                  ).map(([key, label, value]) => (
                    <label key={key} className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400">
                      {label} %
                      <input
                        type="number"
                        step="0.1"
                        min={0}
                        max={100}
                        disabled={readOnly || !m}
                        value={Math.round(value * 1000) / 10}
                        onChange={(e) => setPercent(p, key, e.target.value)}
                        className={`w-20 ${field}`}
                      />
                    </label>
                  ))}
                  {m ? (
                    <Link href={`${MODELS}/${m.id}`} className="text-xs text-brand-600 hover:underline dark:text-brand-400">
                      Edit module
                    </Link>
                  ) : null}
                  {!readOnly ? (
                    <button
                      type="button"
                      onClick={() => onChange(placements.filter((x) => x.id !== p.id))}
                      aria-label={`Remove ${m?.name ?? "the module"} from ${host.name}`}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 dark:border-slate-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
