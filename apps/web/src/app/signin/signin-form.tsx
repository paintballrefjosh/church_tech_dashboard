"use client";

import { useEffect, useState } from "react";

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
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      <label className="block">
        <span className="text-sm text-slate-700 dark:text-slate-300">Password</span>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        />
      </label>
      {needsTotp ? (
        <label className="block">
          <span className="text-sm text-slate-700 dark:text-slate-300">Two-factor code</span>
          <input
            name="totp"
            inputMode="numeric"
            pattern="\d{6}"
            required
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm tracking-widest dark:border-slate-700 dark:bg-slate-950"
          />
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
        className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
      >
        {csrfToken ? "Sign in" : "Loading…"}
      </button>
    </form>
  );
}
