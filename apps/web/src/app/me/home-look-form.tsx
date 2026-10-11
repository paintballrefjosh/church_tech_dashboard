"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DASHBOARD_LOOKS, isLookId, type LookId } from "@church/shared";

const nameOf = (id: LookId) => DASHBOARD_LOOKS.find((l) => l.id === id)?.name ?? id;

/** Per-person choice of home page look. "Site default" saves no choice (theme null). */
export function HomeLookForm({
  initial,
  siteDefault,
  available,
}: {
  initial: LookId | null;
  siteDefault: LookId;
  available: LookId[];
}) {
  const router = useRouter();
  const [value, setValue] = useState<LookId | "">(initial ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(next: string) {
    const theme = next === "" ? null : isLookId(next) ? next : null;
    const previous = value;
    setValue(theme ?? "");
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/dashboard/prefs", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ theme }),
      });
      if (!r.ok) {
        setValue(previous);
        let text = `Request failed (${r.status})`;
        try {
          const j = (await r.json()) as { message?: string | string[] };
          if (Array.isArray(j.message)) text = j.message.join(", ");
          else if (typeof j.message === "string") text = j.message;
        } catch {
          /* keep the generic text */
        }
        setMsg({ ok: false, text });
        return;
      }
      setMsg({ ok: true, text: "Saved." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500 dark:text-slate-400">Look</span>
        <select
          value={value}
          disabled={busy}
          onChange={(e) => void save(e.target.value)}
          data-testid="home-look-select"
          className="mt-1 block w-full max-w-xs rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">Site default ({nameOf(siteDefault)})</option>
          {available.map((id) => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </select>
      </label>
      <div className="min-h-[1.25rem]" role="status">
        {msg ? (
          <span className={msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}>
            {msg.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
