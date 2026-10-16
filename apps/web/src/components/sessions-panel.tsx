"use client";

import { useCallback, useEffect, useState } from "react";
import { Laptop, LogOut, Smartphone, Tablet } from "lucide-react";
import { signOut } from "next-auth/react";
import type { UserAgentInfo } from "@church/shared";

interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  browser: UserAgentInfo;
  current: boolean;
}

function ago(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function DeviceIcon({ device }: { device: UserAgentInfo["device"] }) {
  const cls = "h-5 w-5 shrink-0 text-slate-500";
  if (device === "mobile") return <Smartphone className={cls} aria-hidden />;
  if (device === "tablet") return <Tablet className={cls} aria-hidden />;
  return <Laptop className={cls} aria-hidden />;
}

/**
 * The browsers an account is signed in on. `mine` is the person's own Security page (end one, end the others, end all);
 * `adminUserId` is the same list for an admin looking at someone else, who can only sign that person out everywhere.
 */
export function SessionsPanel({ adminUserId }: { adminUserId?: string }) {
  const admin = adminUserId !== undefined;
  const base = admin ? `/api/users/${adminUserId}/sessions` : "/api/me/sessions";
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(base, { credentials: "same-origin", cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      setRows(((await r.json()) as { sessions: SessionRow[] }).sessions);
    } catch {
      setRows([]);
      setMsg({ kind: "err", text: "Could not load the session list." });
    }
  }, [base]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(key: string, url: string, method: "POST" | "DELETE", done: string, after?: () => void) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fetch(url, { method, credentials: "same-origin" });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { message?: string };
        setMsg({ kind: "err", text: body.message ?? `Request failed (${r.status})` });
        return;
      }
      setMsg({ kind: "ok", text: done });
      if (after) after();
      else await load();
    } finally {
      setBusy(null);
    }
  }

  const signOutHere = () => void signOut({ redirectTo: "/signin" });
  const others = (rows ?? []).filter((r) => !r.current);

  return (
    <div className="text-sm">
      {rows === null ? <p className="text-xs text-slate-500">Loading…</p> : null}
      {rows !== null && rows.length === 0 ? (
        <p className="text-xs text-slate-500">
          {admin ? "No tracked browsers." : "Nothing to list yet. Sessions that began before this list existed are not shown, but \"Sign out everywhere\" ends them too."}
        </p>
      ) : null}
      {rows !== null && rows.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2">
              <DeviceIcon device={r.browser.device} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {r.browser.label}
                  {r.current ? (
                    <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300">
                      This browser
                    </span>
                  ) : null}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {r.ip ?? "address unknown"} · active {ago(r.lastSeenAt)} · signed in {ago(r.createdAt)}
                </p>
              </div>
              {!admin ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() =>
                    r.current
                      ? void call(r.id, `/api/me/sessions/${r.id}`, "DELETE", "Signing out…", signOutHere)
                      : void call(r.id, `/api/me/sessions/${r.id}`, "DELETE", "That browser was signed out.")
                  }
                  className="shrink-0 rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
                >
                  {r.current ? "Sign out" : "End session"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {msg ? (
        <p role="status" className={`mt-2 text-xs ${msg.kind === "ok" ? "text-emerald-600" : "text-rose-600"}`}>
          {msg.text}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {!admin && others.length > 0 ? (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void call("others", "/api/me/sessions/revoke-others", "POST", "Every other browser was signed out.")}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Sign out all other browsers
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() =>
            void call(
              "all",
              admin ? `/api/users/${adminUserId}/sessions/revoke` : "/api/me/sessions/revoke-all",
              "POST",
              admin ? "Signed out everywhere." : "Signed out everywhere. Taking you to the sign-in page.",
              admin ? () => void load() : signOutHere,
            )
          }
          className="inline-flex items-center gap-1.5 rounded-md border border-rose-300 px-3 py-1.5 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
        >
          <LogOut className="h-3 w-3" aria-hidden />
          Sign out everywhere
        </button>
      </div>
    </div>
  );
}
