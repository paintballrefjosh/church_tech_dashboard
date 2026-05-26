"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Notification } from "@church/shared";

/**
 * The top-bar notification widget. Polls /unread-count every 30s so the
 * badge stays roughly current without depending on the socket.io connection.
 * Opening the panel triggers a full list fetch; clicking a notification
 * marks it read locally + on the server and follows the link.
 */
export function NotificationBell() {
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[] | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  async function refreshCount() {
    try {
      const r = await fetch("/api/notifications/unread-count", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) return;
      const body = (await r.json()) as { count: number };
      setCount(body.count);
    } catch {
      // network blip; try again next tick
    }
  }

  useEffect(() => {
    void refreshCount();
    const t = setInterval(() => void refreshCount(), 30_000);
    return () => clearInterval(t);
  }, []);

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function openPanel() {
    setOpen(true);
    const r = await fetch("/api/notifications?limit=20", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setItems((await r.json()) as Notification[]);
  }

  async function markRead(id: string) {
    setItems((prev) => prev?.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)) ?? null);
    setCount((c) => Math.max(0, c - 1));
    await fetch(`/api/notifications/${id}/read`, { method: "POST", credentials: "same-origin" });
  }

  async function markAllRead() {
    setItems((prev) => prev?.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })) ?? null);
    setCount(0);
    await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" });
  }

  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        aria-label={`Notifications${count > 0 ? `, ${count} unread` : ""}`}
        onClick={() => (open ? setOpen(false) : void openPanel())}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
      >
        <span aria-hidden>🔔</span>
        {count > 0 ? (
          <span
            data-testid="notification-badge"
            className="absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white"
          >
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[90vw] rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <header className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="text-sm font-semibold">Notifications</span>
            <div className="flex items-center gap-2 text-xs">
              {count > 0 ? (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-brand-600 hover:underline"
                >
                  Mark all read
                </button>
              ) : null}
              <Link
                href="/notifications"
                onClick={() => setOpen(false)}
                className="text-brand-600 hover:underline"
              >
                See all
              </Link>
            </div>
          </header>
          <ul className="max-h-96 divide-y divide-slate-200 overflow-auto dark:divide-slate-800">
            {items === null ? (
              <li className="p-3 text-xs text-slate-500">Loading…</li>
            ) : items.length === 0 ? (
              <li className="p-4 text-center text-xs text-slate-500">Nothing yet.</li>
            ) : (
              items.map((n) => (
                <li key={n.id} className={n.readAt ? "" : "bg-brand-50/40 dark:bg-brand-700/10"}>
                  {n.link ? (
                    <Link
                      href={n.link}
                      onClick={() => {
                        if (!n.readAt) void markRead(n.id);
                        setOpen(false);
                      }}
                      className="block px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Item n={n} />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => !n.readAt && void markRead(n.id)}
                      className="block w-full px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                    >
                      <Item n={n} />
                    </button>
                  )}
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Item({ n }: { n: Notification }) {
  return (
    <>
      <div className="text-sm font-medium">{n.title}</div>
      {n.body ? <div className="mt-0.5 line-clamp-2 text-xs text-slate-500">{n.body}</div> : null}
      <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">
        {new Date(n.createdAt).toLocaleString()}
      </div>
    </>
  );
}
