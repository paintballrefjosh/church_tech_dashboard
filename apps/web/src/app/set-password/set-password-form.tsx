"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const pwd1 = String(data.get("newPassword") ?? "");
    const pwd2 = String(data.get("password2") ?? "");
    if (pwd1.length < 8) return setError("Password must be at least 8 characters.");
    if (pwd1 !== pwd2) return setError("Passwords don't match.");
    setError(null);
    setBusy(true);
    try {
      const r = await fetch("/api/v1/auth/tokens/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: pwd1 }),
      });
      if (!r.ok) {
        const body = await r.text();
        setError(`Couldn't set your password: ${body.slice(0, 200)}`);
        return;
      }
      // Done — send them to /signin to use their new password. They aren't
      // signed in yet (the token flow doesn't mint a session) which is the
      // safer default; we want them to actually type the password once.
      router.push("/signin?passwordSet=1");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3">
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">New password</span>
        <input
          name="newPassword"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">Confirm password</span>
        <input
          name="password2"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        Save password
      </button>
    </form>
  );
}
