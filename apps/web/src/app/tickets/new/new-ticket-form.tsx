"use client";

import { useState, useTransition } from "react";
import { TICKET_PRIORITIES } from "@church/shared";

export function NewTicketForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const data = new FormData(form);
    const title = String(data.get("title") ?? "").trim();
    const description = String(data.get("description") ?? "");
    const priority = String(data.get("priority") ?? "normal");
    if (!title) {
      setError("Title is required.");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, description, priority }),
        credentials: "same-origin",
      });
      if (res.ok) {
        const t = (await res.json()) as { id: string };
        window.location.assign(`/tickets/${t.id}`);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? `Couldn't create ticket (${res.status})`);
    });
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-4">
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Title</span>
        <input
          name="title"
          type="text"
          required
          maxLength={200}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          placeholder="One-line summary"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Description</span>
        <textarea
          name="description"
          rows={8}
          maxLength={20000}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
          placeholder="What's happening? What did you try? Steps to reproduce?"
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Priority</span>
        <select
          name="priority"
          defaultValue="normal"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950"
        >
          {TICKET_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0]!.toUpperCase() + p.slice(1)}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300"
        >
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create ticket"}
        </button>
        <a
          href="/tickets"
          className="text-sm text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
