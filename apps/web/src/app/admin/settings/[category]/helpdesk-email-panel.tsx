"use client";

import Link from "next/link";
import { useState } from "react";
import { PlugZap, RefreshCw } from "lucide-react";
import { LocalDateTime } from "@/components/local-date-time";

export interface InboundStatus {
  enabled: boolean;
  configured: boolean;
  address: string;
  auth: "strict" | "aligned" | "off";
  authServer: string;
  lastRunAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  week: { ticket: number; comment: number; skipped: number; error: number };
  recent: Array<{
    id: string;
    handledAt: string;
    fromAddress: string;
    subject: string;
    outcome: string;
    reason: string | null;
    reasonText: string | null;
    ticketId: string | null;
  }>;
}

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const button =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900";
const OUTCOME: Record<string, { label: string; cls: string }> = {
  ticket: { label: "Ticket opened", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200" },
  comment: { label: "Added to a ticket", cls: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-200" },
  skipped: { label: "Skipped", cls: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  error: { label: "Failed", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-200" },
};

async function call<T>(path: string, method: "GET" | "POST"): Promise<T> {
  const res = await fetch(`/api/v1/tickets/inbound/${path}`, { method, credentials: "same-origin", cache: "no-store" });
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { message?: unknown };
    throw new Error(typeof b.message === "string" ? b.message : `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export function HelpdeskEmailPanel({ initial }: { initial: InboundStatus | null }) {
  const [status, setStatus] = useState(initial);
  const [busy, setBusy] = useState<"test" | "check" | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (!status) {
    return (
      <p className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
        The mailbox status could not be read.
      </p>
    );
  }

  const reload = async () => setStatus(await call<InboundStatus>("status", "GET"));

  async function run(kind: "test" | "check") {
    setBusy(kind);
    setNote(null);
    try {
      if (kind === "test") {
        const r = await call<{ ok: boolean; message: string }>("test", "POST");
        setNote({ ok: r.ok, text: r.message });
      } else {
        const r = await call<{ state: string; handled: number; error?: string }>("check", "POST");
        setNote(
          r.state === "error"
            ? { ok: false, text: r.error ?? "The check failed." }
            : { ok: true, text: r.handled === 0 ? "Checked. No new messages." : `Checked. Handled ${r.handled} new message${r.handled === 1 ? "" : "s"}.` },
        );
        await reload();
      }
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const line = !status.configured
    ? "Not set up yet: fill in the address, server, login and password below."
    : !status.enabled
      ? "Set up, but switched off."
      : status.lastError
        ? "Switched on, but the last check failed."
        : status.lastOkAt
          ? "Switched on and checking every minute."
          : "Switched on. The first check runs within a minute.";
  const tone = status.lastError ? "warn" : status.enabled && status.configured ? "ok" : "off";
  const toneCls =
    tone === "ok"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
      : tone === "warn"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        : "border-slate-300 bg-slate-50 text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200";

  return (
    <section className="mt-6 space-y-4" data-testid="helpdesk-email-panel">
      <div className={`rounded-md border px-3 py-2 text-sm ${toneCls}`} data-testid="inbound-state">
        {line}
        {status.lastError ? <div className="mt-1 font-medium">{status.lastError}</div> : null}
      </div>

      {status.enabled && status.auth === "off" ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Sender checks are off: anyone who can send mail to {status.address || "this mailbox"} can open tickets and comment as any person on this site,
          just by writing their address in the From line. Use this only for a mailbox nobody outside can write to.
        </p>
      ) : null}
      {status.enabled && status.auth !== "off" && status.authServer === "" ? (
        <p className="rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300">
          Tip: fill in &quot;Your mail server&apos;s name in its checks&quot; below. Without it, a mail provider that adds no check of its own would leave the
          sender&apos;s forged one to be believed.
        </p>
      ) : null}

      <div className="max-w-3xl text-sm text-slate-600 dark:text-slate-400">
        <p>
          People write to <strong>{status.address || "the help address"}</strong>. A new message opens a ticket for the person who sent it (they need an account
          here). Ticket emails sent by this site carry <code className="font-mono text-xs">[#123]</code> in the subject and this address as Reply-To, so replying to one adds a comment to that ticket.
          Nothing is ever sent back automatically, and mail in the mailbox is never changed or deleted.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void run("test")} disabled={busy !== null || !status.configured} className={button} data-testid="inbound-test">
          <PlugZap aria-hidden className="h-4 w-4" /> {busy === "test" ? "Testing..." : "Test the connection"}
        </button>
        <button type="button" onClick={() => void run("check")} disabled={busy !== null || !status.configured} className={button} data-testid="inbound-check">
          <RefreshCw aria-hidden className="h-4 w-4" /> {busy === "check" ? "Checking..." : "Check now"}
        </button>
      </div>
      {note ? (
        <p role="status" data-testid="inbound-note" className={`text-sm ${note.ok ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"}`}>
          {note.text}
        </p>
      ) : null}

      <div>
        <h2 className="text-base font-semibold">The last 7 days</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {status.week.ticket} ticket{status.week.ticket === 1 ? "" : "s"} opened, {status.week.comment} repl{status.week.comment === 1 ? "y" : "ies"} added,{" "}
          {status.week.skipped} skipped, {status.week.error} failed.
        </p>
        {status.recent.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500 dark:border-slate-700">No messages yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-md border border-slate-300 dark:border-slate-800">
            <table className="w-full text-left text-sm" data-testid="inbound-recent">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">From</th>
                  <th className="px-3 py-2">Subject</th>
                  <th className="px-3 py-2">What happened</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {status.recent.map((r) => {
                  const o = OUTCOME[r.outcome] ?? { label: r.outcome, cls: "bg-slate-200 text-slate-700" };
                  return (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600 dark:text-slate-400">
                        <LocalDateTime value={r.handledAt} options={WHEN} />
                      </td>
                      <td className="px-3 py-2 text-xs break-all">{r.fromAddress || "-"}</td>
                      <td className="px-3 py-2 text-xs">{r.subject || "(no subject)"}</td>
                      <td className="px-3 py-2 text-xs">
                        <span className={`inline-flex rounded-full px-2 py-0.5 font-medium ${o.cls}`}>{o.label}</span>
                        {r.reasonText ? <span className="ml-2 text-slate-600 dark:text-slate-400">{r.reasonText}</span> : null}
                        {r.ticketId ? (
                          <Link href={`/tickets/${r.ticketId}`} className="ml-2 text-brand-600 hover:underline">
                            Open
                          </Link>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
