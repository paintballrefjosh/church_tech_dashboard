"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { NeedAction } from "@church/shared";

/** How long the "Done" state (with Undo) stays before the page is asked to refresh. */
export const UNDO_WINDOW_MS = 5000;

type Phase = "idle" | "busy" | "done" | "undoing";

interface Call {
  url: string;
  method: "POST" | "DELETE" | "PATCH";
  body?: unknown;
}

function callsFor(action: NeedAction, meId: string): { run: Call; undo: Call } | null {
  switch (action.kind) {
    case "link":
      return null;
    case "unifi_ack": {
      const url = `/api/unifi/devices/${encodeURIComponent(action.mac)}/ack`;
      return { run: { url, method: "POST" }, undo: { url, method: "DELETE" } };
    }
    case "ticket_take": {
      const url = `/api/tickets/${encodeURIComponent(action.ticketId)}`;
      return {
        run: { url, method: "PATCH", body: { assignedUserId: meId } },
        undo: { url, method: "PATCH", body: { assignedUserId: null } },
      };
    }
  }
}

async function send(call: Call): Promise<string | null> {
  try {
    const res = await fetch(call.url, {
      method: call.method,
      credentials: "same-origin",
      headers: call.body === undefined ? undefined : { "content-type": "application/json" },
      body: call.body === undefined ? undefined : JSON.stringify(call.body),
    });
    if (res.ok) return null;
    let detail = "";
    try {
      const j = (await res.json()) as { message?: unknown };
      if (typeof j.message === "string") detail = j.message;
    } catch {
      /* not JSON */
    }
    return detail || (res.status === 403 ? "you do not have permission" : `the server answered ${res.status}`);
  } catch {
    return "the server could not be reached";
  }
}

/**
 * Performs one action of a "needs you" item. A link just navigates. An acknowledge or a take is
 * sent to the existing audited route straight away (optimistic), shows "Done" with an Undo button,
 * and asks the page to refresh (`onChanged`) when the undo window passes, or at once after an
 * undo. Failures are shown in plain words and the button comes back.
 *
 * Styling: `className` on the wrapper, `buttonClassName` on the buttons and the link.
 */
export function NeedActionButton({
  action,
  meId,
  onChanged,
  className = "inline-flex items-center gap-2",
  buttonClassName = "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800",
}: {
  action: NeedAction;
  /** The signed-in person's id (`snapshot.user.id`), used by "take". */
  meId: string;
  onChanged?: () => void;
  className?: string;
  buttonClassName?: string;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (pending.current) {
      pending.current = false;
      changed.current?.();
    }
  }, []);

  // Leaving while a refresh is still owed: ask for it now.
  useEffect(() => flush, [flush]);

  const calls = callsFor(action, meId);
  if (!calls) {
    if (action.kind !== "link") return null;
    return (
      <Link href={action.href} className={buttonClassName}>
        {action.label}
      </Link>
    );
  }

  async function run() {
    if (!calls) return;
    setError(null);
    setPhase("done"); // optimistic
    const failure = await send(calls.run);
    if (failure) {
      setPhase("idle");
      setError(`Could not ${action.label.toLowerCase()}: ${failure}.`);
      return;
    }
    pending.current = true;
    timer.current = setTimeout(flush, UNDO_WINDOW_MS);
  }

  async function undo() {
    if (!calls) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPhase("undoing");
    const failure = await send(calls.undo);
    if (failure) {
      setError(`Could not undo: ${failure}.`);
      setPhase("done");
      pending.current = true;
      timer.current = setTimeout(flush, UNDO_WINDOW_MS);
      return;
    }
    setPhase("idle");
    pending.current = true;
    flush();
  }

  return (
    <span className={className}>
      {phase === "idle" ? (
        <button type="button" onClick={() => void run()} className={buttonClassName}>
          {action.label}
        </button>
      ) : phase === "undoing" ? (
        <span role="status">Undoing…</span>
      ) : (
        <>
          <span role="status">Done</span>
          <button type="button" onClick={() => void undo()} className={buttonClassName}>
            Undo
          </button>
        </>
      )}
      {error ? (
        <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">
          {error}
        </span>
      ) : null}
    </span>
  );
}
