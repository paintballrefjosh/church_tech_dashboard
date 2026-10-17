"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  renderCannedReply,
  type CannedReply,
  type Ticket,
  type TicketComment,
  type TicketPriority,
  type TicketStatus,
} from "@church/shared";
import { StatusBadge, PriorityBadge, STATUS_LABEL } from "../ticket-badges";
import { AttachmentList } from "@/components/attachment-list";
import { TagPicker } from "@/components/tag-picker";
import { TicketCategoryPicker } from "@/components/ticket-category-picker";
import { type TagLike } from "@/components/tag-badge";

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
  useCannedReplies: boolean;
}

export function TicketDetail({
  ticket: initial,
  initialComments,
  initialTags,
  initialCategories,
  me,
  assignableUsers,
  cannedReplies,
  requester,
  can,
}: {
  ticket: Ticket;
  initialComments: TicketComment[];
  initialTags: TagLike[];
  initialCategories: TagLike[];
  me: UserBrief;
  assignableUsers: UserBrief[];
  cannedReplies: CannedReply[];
  requester: UserBrief | null;
  can: Capabilities;
}) {
  const [ticket, setTicket] = useState(initial);
  const [comments, setComments] = useState(initialComments);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Tags and categories are fetched server-side and passed in; the picker
  // mutates these via saveTags/saveCategories below.
  const [tags, setTags] = useState<TagLike[]>(initialTags);
  const [categories, setCategories] = useState<TagLike[]>(initialCategories);
  const router = useRouter();

  async function saveTags(next: TagLike[]) {
    setTags(next);
    await fetch(`/api/tags/for/ticket/${ticket.id}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tagIds: next.map((t) => t.id) }),
    });
    void refreshComments();
  }

  // Categories are a separate, admin-curated catalogue — saved against its own
  // endpoint. We don't roll them into the tag payload so the picker can offer
  // creation only for tags.
  async function saveCategories(next: TagLike[]) {
    setCategories(next);
    await fetch(`/api/ticket-categories/for/${ticket.id}`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ categoryIds: next.map((c) => c.id) }),
    });
    void refreshComments();
  }

  const isOwner = ticket.createdByUserId === me.id;
  // A greeting wants a first name; fall back to the part of the address before the @.
  const requesterName = requester ? (requester.name?.trim().split(/\s+/)[0] ?? requester.email.split("@")[0] ?? "") : "";
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
      void refreshComments();
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
    const thenWaiting = data.get("thenWaiting") === "on" && !isInternal;
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
      // The requester answering a waiting ticket puts it back to work on the server; show that without a reload.
      if (ticket.status === "waiting" && !thenWaiting) {
        const fresh = await fetch(`/api/tickets/${ticket.id}`, { credentials: "same-origin", cache: "no-store" });
        if (fresh.ok) {
          const t = (await fresh.json()) as Ticket;
          if (t.status !== ticket.status) {
            setTicket(t);
            void refreshComments();
          }
        }
      }
      if (thenWaiting) {
        // The question is out: park the ticket until the requester answers (this also pauses its SLA clocks).
        const upd = await fetch(`/api/tickets/${ticket.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "waiting" }),
          credentials: "same-origin",
        });
        if (upd.ok) {
          setTicket((await upd.json()) as Ticket);
          void refreshComments();
        } else {
          setError(`Comment posted, but the status could not be changed (${upd.status})`);
        }
      }
    });
  }

  async function refreshComments() {
    const res = await fetch(`/api/tickets/${ticket.id}/comments`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) setComments((await res.json()) as TicketComment[]);
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

        {ticket.status === "waiting" ? (
          <p
            data-testid="waiting-banner"
            className="rounded-md border border-violet-300 bg-violet-50 px-3 py-2 text-sm text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-200"
          >
            {isOwner
              ? "We are waiting for your reply. Answer below and this ticket goes back to work."
              : `Waiting on the requester${ticket.waitingSince ? ` since ${new Date(ticket.waitingSince).toLocaleString()}` : ""}. The SLA clocks are paused, and their reply puts the ticket back to work.`}
          </p>
        ) : null}

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
              className="mt-1 w-full resize-y rounded-md border border-slate-300 bg-transparent p-3 text-sm outline-none focus:border-brand-500 dark:border-slate-800"
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
            Tags
          </h2>
          <TagPicker value={tags} onChange={(next) => void saveTags(next)} />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Categories
          </h2>
          <TicketCategoryPicker
            value={categories}
            onChange={(next) => void saveCategories(next)}
            canEdit={canEditCore}
          />
        </section>

        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Attachments
          </h2>
          <AttachmentList
            baseUrl={`/api/tickets/${ticket.id}/attachments`}
            canEdit={canEditCore}
            layout="row"
            onChange={() => void refreshComments()}
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
              {comments.map((c) =>
                c.kind === "event" ? (
                  <li
                    key={c.id}
                    className="border-l-2 border-slate-300 pl-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400"
                  >
                    {c.body} · {new Date(c.createdAt).toLocaleString()}
                  </li>
                ) : (
                <li
                  key={c.id}
                  className={`rounded-md border p-3 text-sm ${
                    c.isInternal
                      ? "border-amber-300 bg-amber-50/60 dark:border-amber-700 dark:bg-amber-950/30"
                      : "border-slate-300 dark:border-slate-800"
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
                ),
              )}
            </ul>
          )}

          <form onSubmit={addComment} className="mt-4 space-y-2">
            {can.useCannedReplies ? (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="canned-pick">
                  Insert a saved reply
                </label>
                <select
                  id="canned-pick"
                  data-testid="canned-pick"
                  value=""
                  disabled={cannedReplies.length === 0}
                  onChange={(e) => {
                    const reply = cannedReplies.find((r) => r.id === e.target.value);
                    const box = e.currentTarget.form?.elements.namedItem("body") as HTMLTextAreaElement | null;
                    if (!reply || !box) return;
                    const text = renderCannedReply(reply.body, {
                      requester: requesterName,
                      agent: me.name ?? me.email,
                      ticket_number: String(ticket.number),
                      ticket_title: ticket.title,
                    });
                    box.value = box.value.trim() ? `${box.value.replace(/\s+$/, "")}\n\n${text}` : text;
                    box.focus();
                  }}
                  className="rounded-md border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-700"
                >
                  <option value="">{cannedReplies.length === 0 ? "No saved replies yet" : "Insert a saved reply..."}</option>
                  {cannedReplies.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
                <Link href="/tickets/canned-replies" className="text-xs text-brand-600 hover:underline">
                  Manage saved replies
                </Link>
              </div>
            ) : null}
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
              {can.writeAny && !isOwner && (ticket.status === "open" || ticket.status === "in_progress") ? (
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" name="thenWaiting" data-testid="then-waiting" />
                  Then wait for the requester
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

      <aside className="space-y-4 rounded-md border border-slate-300 p-4 text-sm dark:border-slate-800">
        <Field label="Status">
          {allowedStatuses.length > 0 ? (
            <select
              aria-label="Status"
              value={ticket.status}
              onChange={(e) => patch({ status: e.target.value as TicketStatus })}
              disabled={pending}
              className="w-full rounded-md border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            >
              {allowedStatuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
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
              aria-label="Priority"
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
            {ticket.createdByUserId === me.id ? "you" : requester ? (requester.name ?? requester.email) : ticket.createdByUserId.slice(0, 8)}
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
          <div className="border-t border-slate-300 pt-3 dark:border-slate-800">
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
