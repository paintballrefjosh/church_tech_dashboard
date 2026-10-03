"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type {
  Ticket,
  TicketPriority,
  TicketSlaMap,
  TicketStatus,
} from "@church/shared";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@church/shared";
import { PriorityBadge, SlaBadge, StatusBadge } from "./ticket-badges";

/**
 * Client island for the tickets list. Renders the same row layout as the
 * server-rendered list but adds a checkbox column + selection-aware action
 * bar at the bottom. Bulk actions hit POST /api/tickets/bulk (proxied) and
 * then refresh the page so the list reflects server state.
 *
 * `canAdmin` gates the action bar — owners without TICKETS_ADMIN don't see
 * bulk controls. The backend re-checks per-row, so this is purely UX.
 */
export function TicketsListClient({
  tickets,
  slaTargets,
  canAdmin,
}: {
  tickets: Ticket[];
  slaTargets: TicketSlaMap;
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = useMemo(
    () => tickets.length > 0 && tickets.every((t) => selected.has(t.id)),
    [tickets, selected],
  );

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(tickets.map((t) => t.id)));
  }

  async function applyBulk(action: unknown) {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Hit the API directly through Caddy — `/api/v1/*` is proxied straight
      // through and carries the user's session cookie via same-origin.
      const res = await fetch("/api/v1/tickets/bulk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ids: [...selected], action }),
      });
      if (!res.ok) {
        setError(`Bulk failed (${res.status})`);
        return;
      }
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (tickets.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
        No tickets match these filters.{" "}
        <Link href="/tickets/new" className="text-brand-600 underline">
          Open a new one
        </Link>
        .
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
        {canAdmin ? (
          <li className="flex items-center gap-3 bg-slate-50 px-4 py-2 text-xs text-slate-500 dark:bg-slate-900 dark:text-slate-400">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              aria-label="Select all"
              className="h-4 w-4"
            />
            <span>{selected.size > 0 ? `${selected.size} selected` : "Select"}</span>
          </li>
        ) : null}
        {tickets.map((t) => {
          const isChecked = selected.has(t.id);
          return (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900">
              {canAdmin ? (
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggle(t.id)}
                  aria-label={`Select ticket #${t.number}`}
                  className="h-4 w-4"
                />
              ) : null}
              <Link
                href={`/tickets/${t.id}`}
                className="flex flex-1 items-center gap-3"
              >
                <span className="w-12 font-mono text-xs text-slate-500 dark:text-slate-400">
                  #{t.number}
                </span>
                <span className="flex-1 truncate text-sm font-medium">{t.title}</span>
                <SlaBadge ticket={t} slaTargets={slaTargets} />
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
                <span className="hidden w-32 text-right text-xs text-slate-500 dark:text-slate-400 sm:inline">
                  {new Date(t.updatedAt).toLocaleString()}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      {canAdmin && selected.size > 0 ? (
        <div className="sticky bottom-4 z-30 mt-4 flex flex-wrap items-center gap-3 rounded-md border border-slate-300 bg-white p-3 shadow-lg dark:border-slate-700 dark:bg-slate-900">
          <span className="text-sm">
            <strong>{selected.size}</strong> selected
          </span>
          <select
            disabled={busy}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (TICKET_STATUSES.includes(v as TicketStatus)) {
                void applyBulk({ kind: "set_status", status: v });
              }
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Set status…</option>
            {TICKET_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            disabled={busy}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              e.target.value = "";
              if (TICKET_PRIORITIES.includes(v as TicketPriority)) {
                void applyBulk({ kind: "set_priority", priority: v });
              }
            }}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <option value="">Set priority…</option>
            {TICKET_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => applyBulk({ kind: "assign", assignedUserId: null })}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Unassign
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm(`Delete ${selected.size} ticket(s)? This cannot be undone.`)) return;
              void applyBulk({ kind: "delete" });
            }}
            className="rounded-md border border-rose-300 px-2 py-1 text-sm text-rose-700 hover:bg-rose-50 dark:border-rose-700 dark:text-rose-300 dark:hover:bg-rose-900/30"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-slate-500 hover:underline"
          >
            Clear selection
          </button>
          {error ? <p className="w-full text-xs text-rose-600">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
