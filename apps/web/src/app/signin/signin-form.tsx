"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * Hydrates a native HTML form with a freshly-fetched CSRF token. We use a
 * regular form POST (not fetch) so the browser applies Auth.js's
 * Set-Cookie + Location redirect natively — exactly the flow Auth.js expects.
 */
export function SignInForm({
  callbackUrl,
  needsTotp,
}: {
  callbackUrl: string;
  needsTotp: boolean;
}) {
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" })
      .then((r) => r.json() as Promise<{ csrfToken: string }>)
      .then((d) => setCsrfToken(d.csrfToken))
      .catch(() => setLoadError("Could not load sign-in form. Refresh to try again."));
  }, []);

  return (
    <form
      action="/api/auth/callback/credentials"
      method="POST"
      className="mt-2 space-y-3"
    >
      <input type="hidden" name="csrfToken" value={csrfToken ?? ""} />
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">Email or username</span>
        <input
          name="email"
          type="text"
          inputMode="email"
          required
          autoComplete="username"
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      {needsTotp ? (
        <label className="block">
          <span className="text-sm text-slate-700 dark:text-slate-300">Two-factor code</span>
          <input
            name="totp"
            autoComplete="one-time-code"
            required
            placeholder="6-digit code, or recovery code"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm transition focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-950"
          />
          <span className="mt-1 block text-[10px] text-slate-500 dark:text-slate-400">
            Lost your phone? Enter one of your one-time recovery codes instead.
          </span>
        </label>
      ) : null}
      {loadError ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {loadError}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!csrfToken}
        className="w-full rounded-lg bg-brand-600 px-3 py-2.5 text-sm font-medium text-white shadow-sm shadow-brand-600/30 transition hover:-translate-y-px hover:bg-brand-700 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:translate-y-0 disabled:opacity-60 disabled:shadow-none dark:focus-visible:ring-offset-slate-900"
      >
        {csrfToken ? "Sign in" : "Loading…"}
      </button>
      <Link
        href="/forgot-password"
        className="block text-center text-xs text-slate-500 hover:underline"
      >
        Forgot password?
      </Link>
    </form>
  );
}
