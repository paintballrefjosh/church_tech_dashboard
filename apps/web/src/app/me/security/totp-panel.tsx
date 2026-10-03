"use client";

import { useState } from "react";

type EnrollResponse = { otpauth: string; qr: string; recoveryCodes: string[] };

export function TotpPanel({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [qr, setQr] = useState<string | null>(null);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  async function startEnroll() {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await fetch("/api/auth/totp/enroll", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!r.ok) {
        setErr(await readError(r));
        return;
      }
      const body = (await r.json()) as EnrollResponse;
      setQr(body.qr);
      setOtpauth(body.otpauth);
      setRecoveryCodes(body.recoveryCodes ?? null);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnroll() {
    if (!/^\d{6}$/.test(code)) {
      setErr("Enter the 6-digit code from your authenticator");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/totp/confirm", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) {
        setErr(await readError(r));
        return;
      }
      setEnabled(true);
      setQr(null);
      setOtpauth(null);
      setCode("");
      setOk("Two-factor authentication is now enabled.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!/^\d{6}$/.test(code)) {
      setErr("Enter a current 6-digit code to disable two-factor");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/auth/totp", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r.ok) {
        setErr(await readError(r));
        return;
      }
      setEnabled(false);
      setCode("");
      setOk("Two-factor authentication disabled. Re-enroll any time below.");
    } finally {
      setBusy(false);
    }
  }

  if (enabled && !qr) {
    return (
      <div className="space-y-3" data-testid="totp-enabled">
        <p className="text-sm">
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
            Enabled
          </span>
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          To disable, enter a current code from your authenticator and confirm.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={disable}
            disabled={busy}
            className="rounded-md border border-rose-300 px-3 py-2 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
          >
            Disable two-factor
          </button>
        </div>
        {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
        {ok ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{ok}</p> : null}
      </div>
    );
  }

  if (qr && otpauth) {
    return (
      <div className="space-y-4" data-testid="totp-enrolling">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Scan this QR code with your authenticator app, then enter the 6-digit
          code it generates to confirm enrollment.
        </p>
        <div
          className="inline-block rounded-md border border-slate-300 bg-white p-3 dark:border-slate-700"
          dangerouslySetInnerHTML={{ __html: qr }}
        />
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-500">
            Can&apos;t scan? Show the setup key
          </summary>
          <code className="mt-2 block break-all rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">
            {otpauth}
          </code>
        </details>
        {recoveryCodes && recoveryCodes.length > 0 ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-900/20">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-200">
              Save these recovery codes somewhere safe — we won&apos;t show them again.
              Each can be used once if you lose access to your authenticator.
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-amber-900 dark:text-amber-100">
              {recoveryCodes.map((rc) => (
                <li key={rc}>{rc}</li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}
              className="mt-2 text-xs text-amber-800 underline hover:no-underline dark:text-amber-200"
            >
              Copy all to clipboard
            </button>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="w-32 rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="button"
            onClick={confirmEnroll}
            disabled={busy}
            className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
          >
            Confirm
          </button>
        </div>
        {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="totp-disabled">
      <p className="text-sm">
        <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
          Not enrolled
        </span>
      </p>
      <button
        type="button"
        onClick={startEnroll}
        disabled={busy}
        className="rounded-md bg-brand-600 px-3 py-2 text-sm text-white hover:bg-brand-700 disabled:opacity-50"
      >
        Set up two-factor
      </button>
      {err ? <p className="text-sm text-rose-600 dark:text-rose-400">{err}</p> : null}
      {ok ? <p className="text-sm text-emerald-600 dark:text-emerald-400">{ok}</p> : null}
    </div>
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
