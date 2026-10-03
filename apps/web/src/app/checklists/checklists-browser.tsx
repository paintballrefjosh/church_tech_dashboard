"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarClock, CalendarDays, ChevronLeft, ChevronRight, List } from "lucide-react";
import type { ChecklistEvent } from "@church/shared";

type View = "calendar" | "list";
type Range = "upcoming" | "past" | "all";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const timeFmt: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const fullFmt: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

function segBtn(active: boolean) {
  return `inline-flex items-center gap-1.5 px-3 py-1.5 text-sm transition ${
    active
      ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
      : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
  }`;
}

export function ChecklistsBrowser({ events }: { events: ChecklistEvent[] }) {
  // Dates are rendered in the viewer's timezone, so hold off until mounted to
  // avoid a server/client hydration mismatch on which day an event lands.
  const [mounted, setMounted] = useState(false);
  const [view, setView] = useState<View>("calendar");
  const [range, setRange] = useState<Range>("upcoming");
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  useEffect(() => setMounted(true), []);

  const scheduled = useMemo(
    () =>
      events
        .filter((e) => e.scheduledAt)
        .map((e) => ({ e, at: new Date(e.scheduledAt as string) }))
        .sort((a, b) => a.at.getTime() - b.at.getTime()),
    [events],
  );
  const unscheduled = events.filter((e) => !e.scheduledAt);

  if (!mounted) return <div className="mt-6 h-96" aria-hidden />;

  const now = Date.now();
  const cutoff = now - 86_400_000;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
          <button type="button" className={segBtn(view === "calendar")} onClick={() => setView("calendar")}>
            <CalendarDays className="h-4 w-4" aria-hidden /> Calendar
          </button>
          <button type="button" className={segBtn(view === "list")} onClick={() => setView("list")}>
            <List className="h-4 w-4" aria-hidden /> List
          </button>
        </div>
        {view === "list" ? (
          <div className="inline-flex overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
            {(["upcoming", "past", "all"] as const).map((r) => (
              <button key={r} type="button" className={segBtn(range === r)} onClick={() => setRange(r)}>
                {r === "upcoming" ? "Upcoming" : r === "past" ? "Past" : "All"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {view === "calendar" ? (
        <CalendarView month={month} setMonth={setMonth} scheduled={scheduled} />
      ) : (
        <ListView
          range={range}
          items={scheduled.filter(({ at }) =>
            range === "all" ? true : range === "upcoming" ? at.getTime() >= cutoff : at.getTime() < cutoff,
          )}
        />
      )}

      {unscheduled.length > 0 && (view === "calendar" || range !== "past") ? (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Unscheduled
          </h2>
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
            {unscheduled.map((e) => (
              <li key={e.id}>
                <Link href={`/checklists/${e.id}`} className="block px-4 py-2 text-sm hover:bg-slate-50 dark:hover:bg-slate-900">
                  {e.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function CalendarView({
  month,
  setMonth,
  scheduled,
}: {
  month: Date;
  setMonth: (d: Date) => void;
  scheduled: { e: ChecklistEvent; at: Date }[];
}) {
  const byDay = new Map<string, { e: ChecklistEvent; at: Date }[]>();
  for (const s of scheduled) {
    const k = dayKey(s.at);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }
  // Sunday-first grid covering whole weeks around the month.
  const lead = month.getDay();
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - lead);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((lead + daysInMonth) / 7) * 7;
  const days = Array.from({ length: cells }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const today = dayKey(new Date());
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));

  return (
    <section className="mt-4">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={() => shift(-1)} aria-label="Previous month" className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => shift(1)} aria-label="Next month" className="rounded-md border border-slate-300 p-1.5 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800">
          <ChevronRight className="h-4 w-4" />
        </button>
        <h2 className="text-base font-semibold">
          {month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </h2>
        <button
          type="button"
          onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          className="ml-auto rounded-md border border-slate-300 px-2.5 py-1 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          Today
        </button>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[640px] grid-cols-7 overflow-hidden rounded-md border border-slate-300 dark:border-slate-800">
          {WEEKDAYS.map((w) => (
            <div key={w} className="border-b border-slate-300 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-500 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              {w}
            </div>
          ))}
          {days.map((d) => {
            const inMonth = d.getMonth() === month.getMonth();
            const items = byDay.get(dayKey(d)) ?? [];
            const isToday = dayKey(d) === today;
            return (
              <div
                key={d.toISOString()}
                className={`min-h-24 border-b border-r border-slate-200 p-1 dark:border-slate-800 ${
                  inMonth ? "" : "bg-slate-50/60 text-slate-400 dark:bg-slate-900/40 dark:text-slate-600"
                }`}
              >
                <div
                  className={`mb-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs ${
                    isToday ? "bg-brand-600 font-semibold text-white" : ""
                  }`}
                >
                  {d.getDate()}
                </div>
                <ul className="space-y-0.5">
                  {items.map(({ e, at }) => (
                    <li key={e.id}>
                      <Link
                        href={`/checklists/${e.id}`}
                        title={`${e.name} - ${at.toLocaleString(undefined, fullFmt)}`}
                        className="block truncate rounded bg-brand-600/10 px-1.5 py-0.5 text-xs text-slate-800 hover:bg-brand-600/20 dark:text-slate-100"
                      >
                        <span className="text-slate-500 dark:text-slate-400">{at.toLocaleTimeString(undefined, timeFmt)}</span>{" "}
                        {e.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ListView({ items, range }: { items: { e: ChecklistEvent; at: Date }[]; range: Range }) {
  const rows = range === "past" ? [...items].reverse() : items;
  if (rows.length === 0) {
    return (
      <p className="mt-4 rounded-md border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
        {range === "past" ? "No past events." : "Nothing scheduled."}
      </p>
    );
  }
  return (
    <ul className="mt-4 divide-y divide-slate-200 rounded-md border border-slate-300 dark:divide-slate-800 dark:border-slate-800">
      {rows.map(({ e, at }) => (
        <li key={e.id}>
          <Link
            href={`/checklists/${e.id}`}
            className="flex items-center gap-3 px-4 py-3 transition hover:bg-slate-50 dark:hover:bg-slate-900"
          >
            <CalendarClock className="h-4 w-4 shrink-0 text-slate-500" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{e.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">{at.toLocaleString(undefined, fullFmt)}</div>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
