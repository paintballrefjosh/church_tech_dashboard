"use client";

import { useMemo, useState, useTransition } from "react";

type Known = {
  key: string;
  type: "string" | "boolean" | "number" | "secret" | "json";
  label: string;
  description: string;
  defaultValue: unknown;
  category: string;
};

export function SettingsForm({
  known,
  current,
}: {
  known: Known[];
  current: Record<string, unknown>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const out: Record<string, unknown> = {};
    for (const s of known) out[s.key] = s.key in current ? current[s.key] : s.defaultValue;
    return out;
  });
  const [saving, startTransition] = useTransition();
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const byCategory = useMemo(() => {
    const map = new Map<string, Known[]>();
    for (const s of known) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return Array.from(map.entries());
  }, [known]);

  function setVal(key: string, v: unknown) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus(null);
    startTransition(async () => {
      // Persist any value that has changed from `current`. Skip secrets that look
      // unchanged (empty string from a masked input) so we don't wipe them.
      const tasks: Promise<Response>[] = [];
      for (const s of known) {
        const next = values[s.key];
        const prev = s.key in current ? current[s.key] : s.defaultValue;
        if (s.type === "secret" && next === "") continue;
        if (JSON.stringify(next) === JSON.stringify(prev)) continue;
        tasks.push(
          fetch(`/admin/settings/save/${encodeURIComponent(s.key)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ value: next }),
            credentials: "same-origin",
          })
        );
      }
      if (tasks.length === 0) {
        setStatus({ kind: "ok", text: "Nothing to save." });
        return;
      }
      const results = await Promise.all(tasks);
      const failures = results.filter((r) => !r.ok);
      if (failures.length) {
        setStatus({ kind: "err", text: `${failures.length} setting(s) failed to save.` });
      } else {
        setStatus({ kind: "ok", text: `Saved ${tasks.length} setting(s).` });
      }
    });
  }

  return (
    <form onSubmit={onSave} className="mt-6 space-y-8">
      {byCategory.map(([category, items]) => (
        <section key={category}>
          <h2 className="text-base font-semibold capitalize">{category}</h2>
          <div className="mt-3 divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
            {items.map((s) => (
              <SettingField key={s.key} setting={s} value={values[s.key]} onChange={(v) => setVal(s.key, v)} />
            ))}
          </div>
        </section>
      ))}

      {status ? (
        <p
          role="status"
          className={`rounded-md border px-3 py-2 text-sm ${
            status.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
          }`}
        >
          {status.text}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {saving ? "Saving…" : "Save all changes"}
      </button>
    </form>
  );
}

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: Known;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="grid gap-2 p-4 sm:grid-cols-[1fr_2fr]">
      <div>
        <div className="font-mono text-xs text-slate-500 dark:text-slate-400">{setting.key}</div>
        <div className="text-sm font-medium">{setting.label}</div>
        <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{setting.description}</div>
      </div>
      <div>
        {setting.type === "boolean" ? (
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span>Enabled</span>
          </label>
        ) : setting.type === "number" ? (
          <input
            type="number"
            value={typeof value === "number" ? value : 0}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        ) : setting.type === "secret" ? (
          <input
            type="password"
            placeholder={value ? "(unchanged)" : ""}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        ) : setting.type === "json" ? (
          <textarea
            value={typeof value === "string" ? value : JSON.stringify(value ?? "", null, 2)}
            onChange={(e) => {
              try {
                onChange(JSON.parse(e.target.value));
              } catch {
                onChange(e.target.value);
              }
            }}
            rows={5}
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
        ) : (
          <input
            type="text"
            value={typeof value === "string" ? value : value == null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          />
        )}
      </div>
    </div>
  );
}
