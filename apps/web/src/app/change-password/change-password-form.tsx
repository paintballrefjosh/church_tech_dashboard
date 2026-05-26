"use client";

import { useState } from "react";

/**
 * Native HTML form submission. Posts to /change-password/submit which redirects
 * back to "/" on success and to /change-password?error=... on failure. We do a
 * tiny bit of JS so the password-match check happens client-side too.
 */
export function ChangePasswordForm() {
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const form = e.currentTarget;
    const data = new FormData(form);
    const pwd1 = String(data.get("newPassword") ?? "");
    const pwd2 = String(data.get("password2") ?? "");
    if (pwd1.length < 8) {
      e.preventDefault();
      setError("Password must be at least 8 characters.");
      return;
    }
    if (pwd1 !== pwd2) {
      e.preventDefault();
      setError("Passwords don't match.");
      return;
    }
    if (pwd1 === "admin") {
      e.preventDefault();
      setError("Choose a password other than the default.");
      return;
    }
    setError(null);
    // Let the native form submit proceed.
  }

  return (
    <form
      onSubmit={onSubmit}
      action="/change-password/submit"
      method="POST"
      className="mt-5 space-y-3"
    >
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
        className="w-full rounded-md bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
      >
        Save new password
      </button>
    </form>
  );
}
