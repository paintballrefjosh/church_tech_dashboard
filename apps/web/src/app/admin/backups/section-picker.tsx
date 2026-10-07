"use client";

import type { BackupRestoreSection } from "@church/shared";

/**
 * Which parts of the data a restore covers. Everything is chosen by default (a full rollback); unchecking a
 * section leaves that part of the site exactly as it is now.
 */
export function SectionPicker({
  sections,
  value,
  onChange,
  disabled,
}: {
  sections: BackupRestoreSection[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const chosen = new Set(value);
  const toggle = (key: string) => {
    const next = new Set(chosen);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(sections.map((s) => s.key).filter((k) => next.has(k)));
  };
  return (
    <fieldset className="mt-3" data-testid="section-picker" disabled={disabled}>
      <legend className="text-sm font-medium">What to restore</legend>
      <p className="mt-0.5 text-xs text-slate-500">
        Everything is chosen by default. Uncheck a section to leave it exactly as it is now. Some data refers to other data (a wiki page to its author, a ticket to the person who made it): rows
        that would refer to something that no longer exists are skipped, and rows that something you left out still uses are kept. The comparison shows both.
      </p>
      <div className="mt-2 flex gap-3 text-xs">
        <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => onChange(sections.map((s) => s.key))} disabled={disabled}>
          Select everything
        </button>
        <button type="button" className="text-brand-700 hover:underline dark:text-brand-300" onClick={() => onChange([])} disabled={disabled}>
          Select nothing
        </button>
      </div>
      <ul className="mt-2 grid gap-2 md:grid-cols-2">
        {sections.map((s) => (
          <li key={s.key}>
            <label className={`flex h-full cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm ${chosen.has(s.key) ? "border-brand-400 bg-brand-50/60 dark:border-brand-700 dark:bg-brand-950/30" : "border-slate-300 dark:border-slate-700"}`}>
              <input type="checkbox" className="mt-1" checked={chosen.has(s.key)} onChange={() => toggle(s.key)} data-testid={`section-${s.key}`} />
              <span>
                <span className="font-medium">{s.title}</span>
                <span className="block text-xs text-slate-600 dark:text-slate-400">{s.description}</span>
                <span className="mt-0.5 block text-[11px] text-slate-500">Includes: {s.tables.join(", ")}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}
