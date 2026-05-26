"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Note, Ticket, TicketStatus, WikiPage } from "@church/shared";

export function TicketsSummaryTile() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tickets?scope=own&limit=20", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setTickets((await r.json()) as Ticket[]);
      })
      .catch(() => setError("failed"));
  }, []);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!tickets) return <p className="text-xs text-slate-400">Loading…</p>;

  const counts: Record<TicketStatus, number> = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
  for (const t of tickets) counts[t.status as TicketStatus]++;
  const recent = tickets.slice(0, 4);

  return (
    <div className="flex h-full flex-col">
      <ul className="mb-3 grid grid-cols-2 gap-2 text-sm">
        {(["open", "in_progress", "resolved", "closed"] as TicketStatus[]).map((s) => (
          <li key={s} className="rounded border border-slate-200 px-2 py-1 dark:border-slate-700">
            <div className="text-xs uppercase tracking-wide text-slate-500">{s.replace("_", " ")}</div>
            <div className="text-base font-semibold">{counts[s]}</div>
          </li>
        ))}
      </ul>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent</h3>
      {recent.length === 0 ? (
        <p className="text-xs text-slate-500">No tickets yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {recent.map((t) => (
            <li key={t.id}>
              <Link
                href={`/tickets/${t.id}`}
                className="flex items-center gap-2 truncate hover:underline"
              >
                <span className="font-mono text-xs text-slate-500">#{t.number}</span>
                <span className="truncate">{t.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-3 text-xs">
        <Link href="/tickets" className="text-brand-600 hover:underline">
          All tickets →
        </Link>
      </div>
    </div>
  );
}

export function NotesRecentTile() {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/notes", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setNotes((await r.json()) as Note[]);
      })
      .catch(() => setError("failed"));
  }, []);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!notes) return <p className="text-xs text-slate-400">Loading…</p>;

  const recent = notes.slice(0, 6);
  return (
    <div className="flex h-full flex-col">
      {recent.length === 0 ? (
        <p className="text-xs text-slate-500">No notes yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {recent.map((n) => (
            <li key={n.id} className="truncate">
              <span className="font-medium">{n.title || "(untitled)"}</span>
              {n.body ? (
                <span className="ml-2 text-slate-500">— {n.body.slice(0, 60)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-3 text-xs">
        <Link href="/notes" className="text-brand-600 hover:underline">
          All notes →
        </Link>
      </div>
    </div>
  );
}

export function WikiRecentTile() {
  const [pages, setPages] = useState<WikiPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/wiki", { credentials: "same-origin", cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) {
          setError(`failed (${r.status})`);
          return;
        }
        setPages((await r.json()) as WikiPage[]);
      })
      .catch(() => setError("failed"));
  }, []);

  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!pages) return <p className="text-xs text-slate-400">Loading…</p>;
  const recent = pages.slice(0, 6);
  return (
    <div className="flex h-full flex-col">
      {recent.length === 0 ? (
        <p className="text-xs text-slate-500">No wiki pages yet.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {recent.map((p) => (
            <li key={p.id} className="truncate">
              <Link href={`/wiki/${p.id}`} className="hover:underline">
                {p.title}
              </Link>
              {p.visibility === "group" ? (
                <span className="ml-2 text-[10px] uppercase text-amber-700 dark:text-amber-300">
                  restricted
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto pt-3 text-xs">
        <Link href="/wiki" className="text-brand-600 hover:underline">
          All pages →
        </Link>
      </div>
    </div>
  );
}

export function QuickLinksTile() {
  const Btn = ({ href, label }: { href: string; label: string }) => (
    <Link
      href={href}
      className="rounded-md border border-slate-200 px-3 py-2 text-center text-sm hover:border-brand-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
    >
      {label}
    </Link>
  );
  return (
    <div className="grid h-full grid-cols-2 gap-2 sm:grid-cols-3">
      <Btn href="/tickets/new" label="+ Ticket" />
      <Btn href="/wiki/new" label="+ Wiki page" />
      <Btn href="/notes" label="+ Note" />
      <Btn href="/tickets" label="Tickets" />
      <Btn href="/wiki" label="Wiki" />
      <Btn href="/admin" label="Admin" />
    </div>
  );
}
