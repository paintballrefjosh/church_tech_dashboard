"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Notification } from "@church/shared";

export function NotificationsPanel({
  initial,
  initialUnreadOnly,
}: {
  initial: Notification[];
  initialUnreadOnly: boolean;
}) {
  const [items, setItems] = useState<Notification[]>(initial);
  const [unreadOnly, setUnreadOnly] = useState(initialUnreadOnly);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/notifications?limit=100${unreadOnly ? "&unread=true" : ""}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (r.ok) setItems((await r.json()) as Notification[]);
  }, [unreadOnly]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function markRead(id: string) {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)));
    await fetch(`/api/notifications/${id}/read`, { method: "POST", credentials: "same-origin" });
    if (unreadOnly) void refresh();
  }

  async function markAllRead() {
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" });
    if (unreadOnly) void refresh();
  }

  async function dismiss(id: string) {
    setItems((prev) => prev.filter((n) => n.id !== id));
    await fetch(`/api/notifications/${id}`, { method: "DELETE", credentials: "same-origin" });
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={() => setUnreadOnly(false)}
          aria-pressed={!unreadOnly}
          className={`rounded-md border px-3 py-1.5 ${
            !unreadOnly
              ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
              : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setUnreadOnly(true)}
          aria-pressed={unreadOnly}
          className={`rounded-md border px-3 py-1.5 ${
            unreadOnly
              ? "border-brand-600 bg-brand-50 text-brand-700 dark:bg-brand-700/20"
              : "border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          Unread
        </button>
        <button
          type="button"
          onClick={markAllRead}
          className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Mark all read
        </button>
      </div>

      {items.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {unreadOnly ? "No unread notifications." : "Nothing yet."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {items.map((n) => (
            <li
              key={n.id}
              className={`flex items-start gap-3 px-4 py-3 ${
                n.readAt ? "" : "bg-brand-50/40 dark:bg-brand-700/10"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {n.link ? (
                    <Link
                      href={n.link}
                      onClick={() => !n.readAt && void markRead(n.id)}
                      className="hover:underline"
                    >
                      {n.title}
                    </Link>
                  ) : (
                    n.title
                  )}
                </div>
                {n.body ? (
                  <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{n.body}</div>
                ) : null}
                <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">
                  {new Date(n.createdAt).toLocaleString()} · {n.kind}
                </div>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {!n.readAt ? (
                  <button
                    type="button"
                    onClick={() => void markRead(n.id)}
                    className="text-brand-600 hover:underline"
                  >
                    mark read
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void dismiss(n.id)}
                  className="text-rose-600 hover:underline"
                >
                  dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
