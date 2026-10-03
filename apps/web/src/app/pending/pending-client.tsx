"use client";

import { useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import { io, type Socket } from "socket.io-client";
import { Clock, RefreshCw } from "lucide-react";

/**
 * Interactive holding screen for an external account awaiting admin approval.
 * The wait can be seconds or days, so we advance the user the instant access is
 * granted via three layers, cheapest first:
 *   1. a socket.io "access:granted" event the API emits the moment an admin
 *      approves (instant, no polling);
 *   2. a slow background poll of /api/me as a fallback if the socket dropped;
 *   3. a manual "Check now" button.
 * Any of them, on seeing approvalStatus !== "pending", does a full navigation to
 * "/" so the server re-evaluates access from the DB (not the stale session JWT).
 */
export function PendingClient({ email }: { email: string }) {
  const [checking, setChecking] = useState(false);
  const [stillPending, setStillPending] = useState(false);

  function goHome() {
    // Full load (not router.push) so the home server component re-reads /me.
    window.location.assign("/");
  }

  /** Returns true (and navigates) if the account is no longer pending. */
  async function checkApproved(): Promise<boolean> {
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) return false;
      const me = (await r.json()) as { approvalStatus?: string };
      if (me.approvalStatus !== "pending") {
        goHome();
        return true;
      }
    } catch {
      /* transient — caller decides whether to surface it */
    }
    return false;
  }

  async function onCheckNow() {
    setChecking(true);
    setStillPending(false);
    const approved = await checkApproved();
    if (!approved) setStillPending(true);
    setChecking(false);
  }

  useEffect(() => {
    // Background poll (60s) — belt-and-braces for a dropped socket over a
    // multi-day wait. Cheap GET; the socket below handles the instant case.
    const poll = setInterval(() => void checkApproved(), 60_000);

    let socket: Socket | null = null;
    try {
      socket = io({
        path: "/socket.io",
        transports: ["websocket", "polling"],
        withCredentials: true,
        reconnection: true,
      });
      // The API emits this to user:{id} the moment an admin approves. Re-verify
      // via /api/me before navigating (don't trust the event blindly).
      socket.on("access:granted", () => void checkApproved());
    } catch {
      /* fall back to poll + manual button */
    }

    return () => {
      clearInterval(poll);
      socket?.disconnect();
    };
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border border-slate-300 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          <Clock className="h-6 w-6" aria-hidden />
        </div>
        <h1 className="text-lg font-semibold">Awaiting approval</h1>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
          {email} is signed in, but an administrator needs to approve access before you can use
          the dashboard. This page updates automatically the moment you&apos;re approved — you can
          leave it open.
        </p>

        {stillPending ? (
          <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            Not approved yet. We&apos;ll move you through automatically as soon as you are.
          </p>
        ) : null}

        <button
          type="button"
          onClick={() => void onCheckNow()}
          disabled={checking}
          className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          <RefreshCw className={`h-4 w-4 ${checking ? "animate-spin" : ""}`} aria-hidden />
          {checking ? "Checking…" : "Check now"}
        </button>

        <button
          type="button"
          onClick={() => void signOut({ redirectTo: "/signin" })}
          className="mt-3 w-full rounded-md border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
