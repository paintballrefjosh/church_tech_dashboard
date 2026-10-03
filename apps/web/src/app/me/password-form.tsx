"use client";

import { useState } from "react";
import { KeyRound } from "lucide-react";

export function PasswordForm() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    if (pw.length < 8) {
      setErr("Password must be at least 8 characters.");
      return;
    }
    if (pw !== pw2) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/me/change-password", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ newPassword: pw }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string | string[] };
        const msg = Array.isArray(body.message) ? body.message.join(", ") : body.message;
        setErr(msg ?? `Request failed (${r.status})`);
        return;
      }
      setPw("");
      setPw2("");
      setOk("Password updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <label className="block">
        <span className="text-xs text-slate-500">New password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          minLength={8}
          maxLength={256}
          required
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-xs text-slate-500">Confirm new password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={pw2}
          onChange={(e) => setPw2(e.target.value)}
          minLength={8}
          maxLength={256}
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
          <KeyRound className="h-4 w-4" aria-hidden /> Change password
        </button>
        {err ? <span className="text-rose-600 dark:text-rose-400">{err}</span> : null}
        {ok ? <span className="text-emerald-600 dark:text-emerald-400">{ok}</span> : null}
      </div>
    </form>
  );
}
