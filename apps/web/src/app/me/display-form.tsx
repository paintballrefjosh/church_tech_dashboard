"use client";

import { useState } from "react";

type Width = "fluid" | "narrow" | "standard" | "wide" | "custom";

const PRESETS: { value: Width; label: string; hint: string }[] = [
  { value: "fluid", label: "Fluid", hint: "Fills the viewport." },
  { value: "narrow", label: "Narrow", hint: "Caps at 1024px." },
  { value: "standard", label: "Standard", hint: "Page-natural widths." },
  { value: "wide", label: "Wide", hint: "Caps at 1536px." },
  { value: "custom", label: "Custom", hint: "Set your own cap." },
];

const PX_MIN = 640;
const PX_MAX = 2560;
const PX_DEFAULT = 1280;

export function DisplayForm({
  initial,
  initialPx,
}: {
  initial: Width;
  initialPx: number | null;
}) {
  const [width, setWidth] = useState<Width>(initial);
  const [px, setPx] = useState<number>(initialPx ?? PX_DEFAULT);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function commit(next: Width, nextPx: number | null) {
    setErr(null);
    setBusy(true);
    applyImmediate(next, nextPx);
    try {
      const payload: Record<string, unknown> = { pageWidth: next };
      // When "custom" is the active mode, always send the px so the server
      // doesn't blank it on the first toggle into custom. For every other
      // mode, send null to clear any stale px value.
      payload.pageWidthPx = next === "custom" ? nextPx ?? PX_DEFAULT : null;
      const r = await fetch("/api/me", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        applyImmediate(width, initialPx);
        setErr(await readError(r));
        return;
      }
      // The DB is the source of truth; the root layout reads page width from
      // /me on each render, so a persisted change survives reload. No session
      // refresh needed (the JWT no longer carries page width).
      setWidth(next);
    } finally {
      setBusy(false);
    }
  }

  function applyImmediate(next: Width, nextPx: number | null) {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    html.dataset.pageWidth = next;
    if (next === "custom" && typeof nextPx === "number") {
      html.style.setProperty("--page-max-width", `${nextPx}px`);
    } else {
      html.style.removeProperty("--page-max-width");
    }
  }

  function pickPreset(next: Width) {
    if (busy) return;
    if (next === width) return;
    commit(next, next === "custom" ? px : null);
  }

  function onSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) return;
    setPx(v);
    // Apply the visual change immediately on every drag step, but only PATCH
    // on commit (mouseup / touchend / keyup) to avoid hammering the API.
    if (width === "custom" && typeof document !== "undefined") {
      document.documentElement.style.setProperty("--page-max-width", `${v}px`);
    }
  }

  function onSliderCommit() {
    if (width !== "custom" || busy) return;
    if (px === initialPx) return;
    commit("custom", px);
  }

  return (
    <div className="space-y-3 text-sm">
      <div role="radiogroup" aria-label="Page width" className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <Option
            key={p.value}
            checked={width === p.value}
            disabled={busy}
            label={p.label}
            hint={p.hint}
            onPick={() => pickPreset(p.value)}
          />
        ))}
      </div>

      {width === "custom" ? (
        <label className="block">
          <span className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Maximum width</span>
            <span className="font-mono tabular-nums">{px}px</span>
          </span>
          <input
            type="range"
            min={PX_MIN}
            max={PX_MAX}
            step={16}
            value={px}
            disabled={busy}
            onChange={onSliderChange}
            onMouseUp={onSliderCommit}
            onTouchEnd={onSliderCommit}
            onKeyUp={onSliderCommit}
            className="mt-2 w-full accent-brand-600"
          />
        </label>
      ) : null}

      <div className="min-h-[1.25rem]">
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
      </div>
    </div>
  );
}

function Option({
  checked,
  disabled,
  label,
  hint,
  onPick,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onPick}
      className={
        "flex-1 min-w-[8rem] rounded-md border px-3 py-2 text-left transition disabled:opacity-50 " +
        (checked
          ? "border-brand-600 bg-brand-50 text-slate-900 dark:border-brand-500 dark:bg-brand-700/30 dark:text-slate-100"
          : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800")
      }
    >
      <div className="font-medium">{label}</div>
      <div className="text-xs text-slate-500 dark:text-slate-400">{hint}</div>
    </button>
  );
}

async function readError(r: Response): Promise<string> {
  try {
    const j = (await r.json()) as { message?: string | string[] };
    if (Array.isArray(j.message)) return j.message.join(", ");
    if (typeof j.message === "string") return j.message;
  } catch {
    /* ignore */
  }
  return `Request failed (${r.status})`;
}
