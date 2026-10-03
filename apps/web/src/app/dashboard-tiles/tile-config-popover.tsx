"use client";

import { useEffect, useRef, useState } from "react";
import { Settings } from "lucide-react";
import type { TileConfigField } from "@church/shared";

/**
 * Cog-icon popover that lets a user tune a tile's runtime config (e.g. how
 * many items to show). Generic over `fields` — the tile catalogue declares
 * what's editable, the popover renders a form, and changes propagate up
 * through `onChange` so the dashboard grid can persist them onto the
 * placement.
 *
 * Changes are debounced (300ms) before firing onChange so a user dragging a
 * number-up arrow doesn't fire a PUT per click.
 */
export function TileConfigPopover({
  fields,
  value,
  onChange,
}: {
  fields: TileConfigField[];
  value: Record<string, string | number | boolean>;
  onChange: (next: Record<string, string | number | boolean>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<Record<string, string | number | boolean>>(value);
  const wrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function setField(key: string, raw: string | number | boolean) {
    setLocal((prev) => {
      const next = { ...prev, [key]: raw };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => onChange(next), 300);
      return next;
    });
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        // tile-no-drag stops the click from initiating a drag in
        // react-grid-layout's draggableCancel matcher.
        className="tile-no-drag rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-white"
        aria-label="Tile settings"
        title="Tile settings"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <Settings className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open ? (
        <div
          role="dialog"
          onMouseDown={(e) => e.stopPropagation()}
          // Always-on `tile-no-drag` so dragging inside the popover doesn't
          // pick the whole tile up.
          className="tile-no-drag absolute right-0 z-50 mt-1 w-64 rounded-md border border-slate-300 bg-white p-3 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Tile settings
          </div>
          <div className="space-y-3">
            {fields.map((f) => (
              <ConfigField
                key={f.key}
                field={f}
                value={local[f.key] ?? f.defaultValue}
                onChange={(v) => setField(f.key, v)}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ConfigField({
  field,
  value,
  onChange,
}: {
  field: TileConfigField;
  value: unknown;
  onChange: (v: string | number | boolean) => void;
}) {
  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 dark:border-slate-700 dark:bg-slate-950"
        />
        <span>
          <span className="font-medium">{field.label}</span>
          {field.description ? (
            <span className="block text-[10px] text-slate-500">{field.description}</span>
          ) : null}
        </span>
      </label>
    );
  }
  return (
    <label className="block text-xs">
      <span className="font-medium">{field.label}</span>
      {field.description ? (
        <span className="block text-[10px] text-slate-500">{field.description}</span>
      ) : null}
      <input
        type="number"
        min={field.min}
        max={field.max}
        value={typeof value === "number" ? value : Number(value ?? field.defaultValue)}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          if (!Number.isFinite(n)) return;
          // Clamp here so a runaway value never reaches the server.
          const clamped = Math.max(field.min ?? 1, Math.min(field.max ?? 999, n));
          onChange(clamped);
        }}
        className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-950"
      />
    </label>
  );
}
