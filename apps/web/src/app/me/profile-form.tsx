"use client";

import { useState } from "react";
import { Save } from "lucide-react";

export function ProfileForm({
  initialName,
  initialEmail,
}: {
  initialName: string;
  initialEmail: string;
}) {
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const payload: Record<string, string> = {};
      if (name.trim() !== initialName) payload.name = name.trim();
      if (email.trim() !== initialEmail) payload.email = email.trim();
      if (Object.keys(payload).length === 0) {
        setOk("Nothing to change.");
        return;
      }
      const r = await fetch("/api/me", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        setErr(await readError(r));
        return;
      }
      setOk("Profile updated.");
      // If email changed, the session cookie still encodes the old email until
      // next sign-in; surface that so users aren't confused.
      if (payload.email) {
        setOk("Profile updated. Sign out and back in to refresh your session.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500">Display name</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          maxLength={120}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">Email</span>
        <input
          type="text"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-2 text-white hover:bg-brand-700 disabled:opacity-50"
        >
          <Save className="h-4 w-4" aria-hidden /> Save
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
        {ok ? <span className="text-emerald-600 dark:text-emerald-400">{ok}</span> : null}
      </div>
    </form>
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
