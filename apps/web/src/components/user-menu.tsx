"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { io, type Socket } from "socket.io-client";
import { Bell, LogOut, Moon, Sun, User as UserIcon, ChevronDown } from "lucide-react";
import { signOut } from "next-auth/react";

/**
 * Username-triggered dropdown holding the four things that used to live
 * scattered across the topbar right-hand side: profile, notifications,
 * theme, sign out. Unread-notification count is rendered as a small badge
 * on the trigger so users keep an at-a-glance signal without a dedicated
 * bell icon.
 */
export function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted ? resolvedTheme === "dark" : false;

  // Mirror the old NotificationBell's unread-count logic: a 30s poll for
  // belt-and-braces, plus a socket.io subscription so a fresh notification
  // updates the badge instantly when the websocket is up.
  async function refreshCount() {
    try {
      const r = await fetch("/api/notifications/unread-count", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) return;
      const body = (await r.json()) as { count: number };
      setUnread(body.count);
    } catch {
      /* transient — try again next tick */
    }
  }

  useEffect(() => {
    void refreshCount();
    const t = setInterval(() => void refreshCount(), 30_000);

    let socket: Socket | null = null;
    try {
      socket = io({
        path: "/socket.io",
        transports: ["websocket", "polling"],
        withCredentials: true,
        reconnection: true,
      });
      socket.on("notification:new", () => {
        setUnread((c) => c + 1);
      });
    } catch {
      /* fall back to poll only */
    }

    // Same-tab signal from /notifications when the user marks read / dismisses
    // / marks-all-read, so the badge updates instantly instead of waiting for
    // the 30s poll. detail: { delta?: number; setTo?: number }.
    function onChanged(e: Event) {
      const detail = (e as CustomEvent<{ delta?: number; setTo?: number }>).detail ?? {};
      setUnread((c) => {
        if (typeof detail.setTo === "number") return Math.max(0, detail.setTo);
        if (typeof detail.delta === "number") return Math.max(0, c + detail.delta);
        return c;
      });
    }
    window.addEventListener("notifications:changed", onChanged);

    return () => {
      clearInterval(t);
      socket?.disconnect();
      window.removeEventListener("notifications:changed", onChanged);
    };
  }, []);

  // Close on outside click + Esc, same pattern as the other dropdowns.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Truncate the trigger label so a long email doesn't blow out the topbar.
  // The full email still appears in the dropdown header.
  const triggerLabel = email.length > 24 ? email.slice(0, 22) + "…" : email;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`relative inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800 ${
          open ? "bg-slate-100 dark:bg-slate-800" : ""
        }`}
        title={email}
      >
        <UserIcon className="h-4 w-4" aria-hidden />
        <span className="hidden max-w-[12rem] truncate sm:inline">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
        {unread > 0 ? (
          <span
            data-testid="notification-badge"
            className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white"
            aria-label={`${unread} unread notifications`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-64 rounded-md border border-slate-300 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <div className="border-b border-slate-100 px-2 pb-2 pt-1 dark:border-slate-800">
            <div className="text-[10px] uppercase tracking-wide text-slate-500">Signed in as</div>
            <div className="truncate text-sm font-medium" title={email}>
              {email}
            </div>
          </div>

          <Link
            role="menuitem"
            href="/me"
            onClick={() => setOpen(false)}
            className="mt-1 flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <UserIcon className="h-4 w-4 text-slate-500" aria-hidden />
            <span>Profile &amp; settings</span>
          </Link>

          <Link
            role="menuitem"
            href="/notifications"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Bell className="h-4 w-4 text-slate-500" aria-hidden />
            <span className="flex-1">Notifications</span>
            {unread > 0 ? (
              <span className="rounded-full bg-rose-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unread > 99 ? "99+" : unread}
              </span>
            ) : null}
          </Link>

          {/* Theme toggle stays an in-menu item rather than navigating away —
              click flips theme, leaves the menu open so users can verify
              the change. Escape/outside-click closes when they're done. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => setTheme(isDark ? "light" : "dark")}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            {mounted && isDark ? (
              <Sun className="h-4 w-4 text-slate-500" aria-hidden />
            ) : (
              <Moon className="h-4 w-4 text-slate-500" aria-hidden />
            )}
            <span>{mounted && isDark ? "Light mode" : "Dark mode"}</span>
          </button>

          <div className="my-1 border-t border-slate-300 dark:border-slate-700" />

          {/* Auth.js client signOut posts to the stable /api/auth/signout
              endpoint (CSRF handled for us) rather than a Server Action, whose
              build-specific id goes stale across redeploys and makes a still-open
              tab's first click silently no-op until a refresh. */}
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              setOpen(false);
              void signOut({ redirectTo: "/signin" });
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-rose-700 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-900/30"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
