"use client";

import Link from "next/link";
import { useState } from "react";

export function ForgotPasswordForm() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = (new FormData(e.currentTarget).get("email") as string) || "";
    setBusy(true);
    try {
      // We don't surface success-vs-failure to avoid email enumeration; the
      // API always returns ok. The UI just says "check your inbox".
      await fetch("/api/v1/auth/tokens/request-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="mt-5 space-y-3 text-sm">
        <p className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-800 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
          If that email matches an account, a reset link is on its way. Check your inbox.
        </p>
        <Link href="/signin" className="block text-center text-brand-600 hover:underline">
          Back to sign-in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3">
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">Email</span>
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        Send reset link
      </button>
      <Link href="/signin" className="block text-center text-xs text-slate-500 hover:underline">
        Back to sign-in
      </Link>
    </form>
  );
}
