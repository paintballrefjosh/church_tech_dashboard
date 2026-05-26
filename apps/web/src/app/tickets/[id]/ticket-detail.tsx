"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Ticket,
  type TicketComment,
  type TicketPriority,
  type TicketStatus,
} from "@church/shared";
import { StatusBadge, PriorityBadge } from "../ticket-badges";
import { AttachmentList } from "@/components/attachment-list";

interface UserBrief {
  id: string;
  email: string;
  name: string | null;
}

interface Capabilities {
  writeAny: boolean;
  writeOwn: boolean;
  assign: boolean;
  deleteAny: boolean;
  writeInternalComment: boolean;
}

export function TicketDetail({
  ticket: initial,
  initialComments,
  me,
  assignableUsers,
  can,
}: {
  ticket: Ticket;
  initialComments: TicketComment[];
  me: UserBrief;
  assignableUsers: UserBrief[];
  can: Capabilities;
}) {
  const [ticket, setTicket] = useState(initial);
  const [comments, setComments] = useState(initialComments);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const isOwner = ticket.createdByUserId === me.id;
  const canEditCore = can.writeAny || (isOwner && can.writeOwn);
  // Owner can only close (and reopen) their own ticket. Staff can set any status.
  const allowedStatuses: TicketStatus[] = can.writeAny
    ? [...TICKET_STATUSES]
    : isOwner
      ? Array.from(new Set<TicketStatus>([ticket.status, "closed", "open"]))
      : [];

  function patch(partial: Partial<Ticket>) {
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(partial),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `Update failed (${res.status})`);
        return;
      }
      setTicket((await res.json()) as Ticket);
    });
  }

  function destroyTicket() {
    if (!can.deleteAny) return;
    if (!confirm(`Delete ticket #${ticket.number}? This cannot be undone.`)) return;
    startTransition(async () => {
      const res = await fetch(`/api/tickets/${ticket.id}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.ok) {
        router.push("/tickets");
      } else {
        setError(`Delete failed (${res.status})`);
      }
    });
  }

  function addComment(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const body = String(data.get("body") ?? "").trim();
    const isInternal = data.get("isInternal") === "on";
    if (!body) return;
    startTransition(async () => {
      const res = await fetch(`/api/tickets/${ticket.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, isInternal }),
        credentials: "same-origin",
      });
      if (!res.ok) {
        const r = (await res.json().catch(() => ({}))) as { message?: string };
        setError(r.message ?? `Comment failed (${res.status})`);
        return;
      }
      const c = (await res.json()) as TicketComment;
      setComments((prev) => [...prev, c]);
      form.reset();
    });
  }

  function deleteComment(cid: string) {
    if (!confirm("Delete this comment?")) return;
    startTransition(async () => {
      const res = await fetch(`/api/tickets/${ticket.id}/comments/${cid}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      if (res.ok) {
        setComments((prev) => prev.filter((c) => c.id !== cid));
      } else {
        setError(`Delete failed (${res.status})`);
      }
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_280px]">
      <div className="space-y-5">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-mono">#{ticket.number}</span>
            <span>·</span>
            <span>opened {new Date(ticket.createdAt).toLocaleString()}</span>
          </div>
          {canEditCore ? (
            <input
              aria-label="Title"
              defaultValue={ticket.title}
              onBlur={(e) => {
                if (e.target.value.trim() && e.target.value !== ticket.title) {
                  patch({ title: e.target.value.trim() });
                }
              }}
              className="w-full bg-transparent text-2xl font-semibold outline-none focus:border-b focus:border-brand-500"
            />
          ) : (
            <h1 className="text-2xl font-semibold">{ticket.title}</h1>
          )}
        </header>

        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Description
          </h2>
          {canEditCore ? (
            <textarea
              aria-label="Description"
              defaultValue={ticket.description}
              onBlur={(e) => {
                if (e.target.value !== ticket.description) patch({ description: e.target.value });
              }}
              rows={6}
              className="mt-1 w-full resize-y rounded-md border border-slate-200 bg-transparent p-3 text-sm outline-none focus:border-brand-500 dark:border-slate-800"
              placeholder="Add detail…"
            />
          ) : (
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
              {ticket.description || <span className="italic text-slate-400">(empty)</span>}
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Attachments
          </h2>
          <AttachmentList
            baseUrl={`/api/tickets/${ticket.id}/attachments`}
            canEdit={canEditCore}
            layout="row"
          />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Comments
          </h2>
          {comments.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No comments yet.</p>
          ) : (
            <ul className="space-y-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className={`rounded-md border p-3 text-sm ${
                    c.isInternal
                      ? "border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30"
                      : "border-slate-200 dark:border-slate-800"
                  }`}
                >
                  <header className="mb-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                    <span>
                      {c.authorUserId === me.id ? "you" : c.authorUserId.slice(0, 8)} ·{" "}
                      {new Date(c.createdAt).toLocaleString()}
                      {c.isInternal ? " · internal" : ""}
                    </span>
                    {c.authorUserId === me.id || can.deleteAny ? (
                      <button
                        type="button"
                        onClick={() => deleteComment(c.id)}
                        className="text-rose-600 hover:text-rose-700"
                      >
                        delete
                      </button>
                    ) : null}
                  </header>
                  <p className="whitespace-pre-wrap">{c.body}</p>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={addComment} className="mt-4 space-y-2">
            <textarea
              name="body"
              required
              rows={3}
              maxLength={20000}
              placeholder="Add a comment…"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={pending}
                className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
              >
                {pending ? "Posting…" : "Comment"}
              </button>
              {can.writeInternalComment ? (
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" name="isInternal" />
                  Internal (staff only)
                </label>
              ) : null}
            </div>
          </form>
        </section>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
          >
            {error}
          </p>
        ) : null}
      </div>

      <aside className="space-y-4 rounded-md border border-slate-200 p-4 text-sm dark:border-slate-800">
        <Field label="Status">
          {allowedStatuses.length > 0 ? (
            <select
              value={ticket.status}
              onChange={(e) => patch({ status: e.target.value as TicketStatus })}
              disabled={pending}
              className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              {allowedStatuses.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          ) : (
            <StatusBadge status={ticket.status} />
          )}
        </Field>

        <Field label="Priority">
          {can.writeAny || (isOwner && can.writeOwn) ? (
            <select
              value={ticket.priority}
              onChange={(e) => patch({ priority: e.target.value as TicketPriority })}
              disabled={pending}
              className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              {TICKET_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <PriorityBadge priority={ticket.priority} />
          )}
        </Field>

        <Field label="Assigned">
          {can.assign ? (
            <select
              value={ticket.assignedUserId ?? ""}
              onChange={(e) =>
                patch({ assignedUserId: e.target.value === "" ? null : e.target.value })
              }
              disabled={pending}
              className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              <option value="">— unassigned —</option>
              {assignableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.email}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-slate-600 dark:text-slate-300">
              {ticket.assignedUserId
                ? assignableUsers.find((u) => u.id === ticket.assignedUserId)?.name ??
                  assignableUsers.find((u) => u.id === ticket.assignedUserId)?.email ??
                  ticket.assignedUserId.slice(0, 8)
                : "unassigned"}
            </span>
          )}
        </Field>

        <Field label="Created by">
          <span className="text-slate-600 dark:text-slate-300">
            {ticket.createdByUserId === me.id ? "you" : ticket.createdByUserId.slice(0, 8)}
          </span>
        </Field>

        {ticket.resolvedAt ? (
          <Field label="Resolved">
            <span className="text-slate-600 dark:text-slate-300">
              {new Date(ticket.resolvedAt).toLocaleString()}
            </span>
          </Field>
        ) : null}
        {ticket.closedAt ? (
          <Field label="Closed">
            <span className="text-slate-600 dark:text-slate-300">
              {new Date(ticket.closedAt).toLocaleString()}
            </span>
          </Field>
        ) : null}

        {can.deleteAny ? (
          <div className="border-t border-slate-200 pt-3 dark:border-slate-800">
            <button
              type="button"
              onClick={destroyTicket}
              disabled={pending}
              className="text-xs text-rose-600 hover:text-rose-700 disabled:opacity-60"
            >
              Delete ticket
            </button>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
