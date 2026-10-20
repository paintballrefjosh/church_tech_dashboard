"use client";

import { useCallback, useEffect, useState } from "react";
import { LayoutGrid, List } from "lucide-react";

export type PortView = "switch" | "list";

const STORAGE_KEY = "church.portView";

/**
 * Which way a person likes to see a device's ports: the picture of the switch (the default) or the table. Remembered
 * in this browser only, and shared by every page that offers the choice (Cisco, and UniFi after it).
 */
export function usePortView(): [PortView, (v: PortView) => void] {
  const [view, setView] = useState<PortView>("switch");

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === "list" || saved === "switch") setView(saved);
    } catch {
      /* storage blocked: the default stands */
    }
  }, []);

  const choose = useCallback((v: PortView) => {
    setView(v);
    try {
      window.localStorage.setItem(STORAGE_KEY, v);
    } catch {
      /* not remembered, still applied */
    }
  }, []);

  return [view, choose];
}

const BASE = "inline-flex items-center gap-1.5 px-2.5 py-1 text-xs";
const ON = "bg-brand-600 text-white";
const OFF = "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800";

/** "Switch view | List view", for the top right of a ports table, beside its rows selector. */
export function PortViewToggle({ value, onChange }: { value: PortView; onChange: (v: PortView) => void }) {
  return (
    <div role="group" aria-label="Show ports as" className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
      <button type="button" aria-pressed={value === "switch"} onClick={() => onChange("switch")} className={`${BASE} ${value === "switch" ? ON : OFF}`}>
        <LayoutGrid className="h-3.5 w-3.5" aria-hidden /> Switch view
      </button>
      <button type="button" aria-pressed={value === "list"} onClick={() => onChange("list")} className={`${BASE} border-l border-slate-300 dark:border-slate-700 ${value === "list" ? ON : OFF}`}>
        <List className="h-3.5 w-3.5" aria-hidden /> List view
      </button>
    </div>
  );
}
