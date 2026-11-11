"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { describeSignageRepeat, localDate, signagePriorityLabel, type SignagePlaylist, type SignageSchedule, type SignageScreen, type SignageScreenGroup } from "@lampstand/shared";
import { usePoll } from "@/lib/use-poll";
import { btnCls, targetText, useSignageJson, useSignagePerms } from "../signage-ui";
import { ScheduleModal, type ModalStart } from "./schedule-form";
import { byDay, dayTitle, entryMatches, hmOf, monthGrid, monthKey, monthTitle, occurrences, shiftMonth, timeOnDay, type Occurrence } from "./schedule-model";

/**
 * The month calendar pieces shared by the Schedule page (every screen) and a screen's own page (`ScreenCalendar`, only that
 * screen's entries and the groups' and all-screens entries that reach it).
 */
/** A switched-off entry: still on the calendar so it can be found and switched back on, but grey and dashed, and always with the word "off" beside it (a colour is never the only sign). */
export const OFF_TONE = "border-l-slate-300 border border-dashed border-slate-300 bg-slate-50 text-slate-500 dark:border-l-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400";

/** Priority colours (always beside the words: a colour is never the only sign). Text on -100 tints is -900, AA in both schemes. */
export const PRIORITY_TONE: Record<number, string> = {
  1: "border-l-slate-400 bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100",
  2: "border-l-sky-500 bg-sky-100 text-sky-950 dark:bg-sky-950 dark:text-sky-100",
  3: "border-l-emerald-600 bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100",
  4: "border-l-amber-500 bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  5: "border-l-rose-600 bg-rose-100 text-rose-950 dark:bg-rose-950 dark:text-rose-100",
};

const WEEK_HEAD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_CHIPS = 3;
export function Chip({ o, day, onPick, onMenu }: { o: Occurrence; day: string; onPick: (o: Occurrence, day: string) => void; onMenu?: (o: Occurrence, day: string, at: { x: number; y: number }) => void }) {
  const e = o.entry;
  const time = timeOnDay(o, day);
  return (
    <button
      type="button"
      onClick={(ev) => {
        ev.stopPropagation();
        onPick(o, day);
      }}
      // A double click on an event is not a double click on the day (that adds a new entry).
      onDoubleClick={(ev) => ev.stopPropagation()}
      onContextMenu={
        onMenu
          ? (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              onMenu(o, day, { x: ev.clientX, y: ev.clientY });
            }
          : undefined
      }
      className={`flex min-h-[24px] w-full items-center gap-1 overflow-hidden rounded border-l-4 px-1.5 text-left text-xs leading-tight ${e.enabled ? (PRIORITY_TONE[e.priority] ?? PRIORITY_TONE[3]) : OFF_TONE}`}
      aria-label={`${e.name}${e.enabled ? "" : " (switched off)"}, ${time}: ${e.playlistName} on ${targetText(e)}, priority ${signagePriorityLabel(e.priority)}`}
    >
      <span className="shrink-0 font-semibold tabular-nums">{o.firstDay === day ? o.startHm : "cont."}</span>
      <span className={`truncate ${e.enabled ? "" : "line-through"}`}>{e.name}</span>
      {e.enabled ? null : <span className="shrink-0 font-semibold">off</span>}
    </button>
  );
}

export function MonthGrid({
  month,
  grid,
  days,
  today,
  selected,
  onSelect,
  onPick,
  canEdit = false,
  onAdd,
}: {
  month: string;
  grid: string[];
  days: Map<string, Occurrence[]>;
  today: string;
  selected: string | null;
  onSelect: (day: string) => void;
  onPick: (o: Occurrence, day: string) => void;
  /** Someone who may change the schedule: a double click on a day adds to it, and a right click offers the same in a menu. */
  canEdit?: boolean;
  onAdd?: (day: string) => void;
}) {
  const [menu, setMenu] = useState<CalendarMenu | null>(null);
  const addOn = canEdit && onAdd ? onAdd : null;
  return (
    <div className="hidden sm:block">
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-slate-300 bg-slate-300 dark:border-slate-800 dark:bg-slate-800">
        {WEEK_HEAD.map((d) => (
          <div key={d} className="bg-slate-100 py-1.5 text-center text-xs font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            {d}
          </div>
        ))}
        {grid.map((day) => {
          const items = days.get(day) ?? [];
          const inMonth = monthKey(day) === month;
          const isToday = day === today;
          const isSel = day === selected;
          const more = items.length - MAX_CHIPS;
          return (
            <div
              key={day}
              onDoubleClick={
                addOn
                  ? () => {
                      onSelect(day);
                      addOn(day);
                    }
                  : undefined
              }
              onContextMenu={
                addOn
                  ? (ev) => {
                      ev.preventDefault();
                      onSelect(day);
                      setMenu({ x: ev.clientX, y: ev.clientY, title: dayTitle(day), items: [{ label: "Add to the schedule", run: () => addOn(day) }, { label: "Cancel", run: () => undefined }] });
                    }
                  : undefined
              }
              className={`flex min-h-[7.5rem] select-none flex-col gap-1 p-1.5 ${inMonth ? "bg-white dark:bg-slate-950" : "bg-slate-50 dark:bg-slate-900/70"} ${isSel ? "ring-2 ring-inset ring-brand-500" : ""}`}
            >
              <button
                type="button"
                onClick={() => onSelect(day)}
                aria-label={`${dayTitle(day)}${isToday ? ", today" : ""}: ${items.length ? `${items.length} on the schedule` : "nothing scheduled"}`}
                aria-pressed={isSel}
                className={`inline-flex h-6 min-w-[24px] items-center justify-center self-start rounded-full px-1.5 text-xs font-semibold ${
                  isToday ? "bg-brand-600 text-white" : inMonth ? "text-slate-800 hover:bg-slate-100 dark:text-slate-100 dark:hover:bg-slate-800" : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {Number(day.slice(8))}
              </button>
              {items.slice(0, MAX_CHIPS).map((o, i) => (
                <Chip
                  key={`${o.entry.id}-${o.start}-${i}`}
                  o={o}
                  day={day}
                  onPick={onPick}
                  onMenu={
                    canEdit
                      ? (occ, d, at) => {
                          onSelect(d);
                          setMenu({ ...at, title: occ.entry.name, items: [{ label: "Edit event", run: () => onPick(occ, d) }, { label: "Cancel", run: () => undefined }] });
                        }
                      : undefined
                  }
                />
              ))}
              {more > 0 ? (
                <button type="button" onClick={() => onSelect(day)} className="min-h-[24px] self-start rounded px-1 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300">
                  {more} more
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <PriorityKey />
      {menu ? <CalendarContextMenu menu={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

export interface CalendarMenu {
  x: number;
  y: number;
  /** What was right-clicked, read out as the menu's name. */
  title: string;
  items: Array<{ label: string; run: () => void }>;
}

/**
 * The right-click menu of the month calendar. Drawn in a portal on `document.body` with `position: fixed` (the cards' backdrop
 * filter would trap it, see CLAUDE.md Accessibility 4), kept inside the window, closed by Escape, a click or a right click
 * elsewhere, scrolling or leaving it with Tab. Arrow keys move, Enter chooses. It is an extra for the mouse: every action also has
 * a button on the page ("Add on this day", the event's own Edit).
 */
export function CalendarContextMenu({ menu, onClose }: { menu: CalendarMenu; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    setPos({ left: Math.max(4, Math.min(menu.x, vw - b.offsetWidth - 4)), top: Math.max(4, Math.min(menu.y, vh - b.offsetHeight - 4)) });
    b.querySelector<HTMLButtonElement>("button")?.focus();
  }, [menu]);

  useEffect(() => {
    const away = (ev: Event) => {
      if (ev.target instanceof Node && box.current?.contains(ev.target)) return;
      onClose();
    };
    document.addEventListener("mousedown", away, true);
    document.addEventListener("contextmenu", away, true);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("contextmenu", away, true);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  function keys(ev: React.KeyboardEvent) {
    const buttons = Array.from(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === "Escape") {
      ev.preventDefault();
      onClose();
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      buttons[(at + 1) % buttons.length]?.focus();
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      buttons[(at - 1 + buttons.length) % buttons.length]?.focus();
    } else if (ev.key === "Tab") {
      onClose();
    }
  }

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={menu.title}
      onKeyDown={keys}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-[70] min-w-[12rem] overflow-hidden rounded-md border border-slate-300 bg-white pb-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
    >
      {/* The header: the day (or the event) the menu is about, tinted so it reads as a title and not as one more choice. */}
      <p className="mb-1 truncate border-b border-sky-200 bg-sky-100 px-3 py-1.5 text-sm font-semibold text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200" aria-hidden>
        {menu.title}
      </p>
      {menu.items.map((it) => (
        <button
          key={it.label}
          type="button"
          role="menuitem"
          className="block min-h-[28px] w-full px-3 py-1 text-left text-sm text-slate-800 hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:text-slate-100 dark:hover:bg-slate-800 dark:focus:bg-slate-800"
          onClick={() => {
            onClose();
            it.run();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function PriorityKey() {
  return (
    <ul className="mt-2 flex flex-wrap gap-2 text-xs" aria-label="Priorities">
      {[5, 4, 3, 2, 1].map((p) => (
        <li key={p} className={`rounded border-l-4 px-1.5 py-0.5 ${PRIORITY_TONE[p]}`}>
          {signagePriorityLabel(p)}
        </li>
      ))}
    </ul>
  );
}

/** Narrow screens: the month as a list of the days that have something on, from today (or the 1st of another month). */
export function MonthAgenda({ month, grid, days, today, onPick }: { month: string; grid: string[]; days: Map<string, Occurrence[]>; today: string; onPick: (o: Occurrence, day: string) => void }) {
  const from = monthKey(today) === month ? today : `${month}-01`;
  const list = grid.filter((d) => monthKey(d) === month && d >= from && (days.get(d)?.length ?? 0) > 0);
  return (
    <div className="sm:hidden">
      {list.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 p-4 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300">Nothing on the schedule {from === today ? "for the rest of this month" : "this month"}.</p>
      ) : (
        <ol className="space-y-3">
          {list.map((d) => (
            <li key={d}>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {dayTitle(d)}
                {d === today ? <span className="ml-1 text-xs font-normal text-slate-500 dark:text-slate-400">today</span> : null}
              </h3>
              <div className="mt-1 space-y-1">
                {days.get(d)!.map((o, i) => (
                  <Chip key={`${o.entry.id}-${o.start}-${i}`} o={o} day={d} onPick={onPick} />
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function PriorityBadge({ p }: { p: number }) {
  return <span className={`rounded border-l-4 px-1.5 py-0.5 text-xs ${PRIORITY_TONE[p] ?? PRIORITY_TONE[3]}`}>{signagePriorityLabel(p)}</span>;
}

/** Which kind of entry, in words. */
export function whenText(e: SignageSchedule, tz: string): string {
  if (e.kind === "once") {
    if (!e.startsAt || !e.endsAt) return "";
    const fmt = (iso: string) => {
      const ms = Date.parse(iso);
      return `${dayTitle(localDate(ms, tz))} ${hmOf(ms, tz)}`;
    };
    return `${fmt(e.startsAt)} to ${fmt(e.endsAt)}`;
  }
  const range = e.startDate || e.endDate ? ` (${e.startDate ? `from ${e.startDate}` : ""}${e.startDate && e.endDate ? " " : ""}${e.endDate ? `until ${e.endDate}` : ""})` : "";
  return `${describeSignageRepeat(e)}${range}`;
}

export function DayPanel({ day, items, tz, canEdit, onEdit, onAdd }: { day: string; items: Occurrence[]; tz: string; canEdit: boolean; onEdit: (e: SignageSchedule) => void; onAdd: () => void }) {
  return (
    <section aria-labelledby="day-panel-title" className="rounded-lg border border-slate-300 p-4 dark:border-slate-800">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="day-panel-title" className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {dayTitle(day)}
        </h2>
        {canEdit ? (
          <button type="button" className={btnCls} onClick={onAdd}>
            <Plus className="h-4 w-4" aria-hidden /> Add on this day
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Nothing scheduled: the screens show their fallback playlists.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {items.map((o, i) => (
            <li key={`${o.entry.id}-${o.start}-${i}`} className={`flex flex-wrap items-start justify-between gap-3 rounded-md border-l-4 p-2.5 ${o.entry.enabled ? (PRIORITY_TONE[o.entry.priority] ?? PRIORITY_TONE[3]) : OFF_TONE}`}>
              <div className="min-w-0">
                <p className="font-medium">
                  <span className="tabular-nums">{timeOnDay(o, day)}</span> · {o.entry.name}
                  {o.entry.enabled ? null : <span className="ml-2 rounded border border-slate-400 px-1.5 py-0.5 text-xs font-semibold">Switched off</span>}
                </p>
                <p className="text-sm">
                  {o.entry.playlistName} on {targetText(o.entry)}
                </p>
                <p className="text-xs">
                  {whenText(o.entry, tz)} · {signagePriorityLabel(o.entry.priority)} priority
                  {o.entry.forcePowerOn ? " · switches TVs on" : ""}
                </p>
              </div>
              {canEdit ? (
                <button type="button" className={`${btnCls} bg-white/70 dark:bg-slate-900/60`} onClick={() => onEdit(o.entry)} aria-label={`Edit ${o.entry.name}`}>
                  Edit
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The full month calendar of ONE screen: what plays on it, from its own entries, its groups' and the all-screens ones. Editing needs Signage write. */
export function ScreenCalendar({ screen }: { screen: SignageScreen }) {
  const perms = useSignagePerms();
  const summary = useSignageJson<{ timezone: string }>("summary");
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");
  const tz = summary.data?.timezone ?? null;
  const [entries, setEntries] = useState<SignageSchedule[] | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ entry: SignageSchedule | null; start: ModalStart } | null>(null);

  const load = async () => {
    const r = await fetch("/api/signage/schedules", { credentials: "same-origin", cache: "no-store" });
    if (r.ok) setEntries((await r.json()) as SignageSchedule[]);
  };
  usePoll(load, 60_000);

  const today = tz ? localDate(Date.now(), tz) : null;
  useEffect(() => {
    if (today && month === null) {
      setMonth(monthKey(today));
      setSelected(today);
    }
  }, [today, month]);

  const shown = useMemo(() => (entries ?? []).filter((e) => entryMatches(e, `screen:${screen.id}`, [screen])), [entries, screen]);
  const grid = useMemo(() => (month ? monthGrid(month) : []), [month]);
  const days = useMemo(() => (tz && grid.length ? byDay(occurrences(shown, grid[0]!, grid[grid.length - 1]!, tz)) : new Map<string, Occurrence[]>()), [shown, grid, tz]);

  const open = (entry: SignageSchedule | null, start: ModalStart = { kind: "new", day: selected ?? today ?? undefined, screenId: screen.id }) => setEditing({ entry, start });
  const pick = (o: Occurrence, day: string) => {
    setSelected(day);
    if (perms.write) open(o.entry);
  };

  return (
    <section aria-labelledby="screen-cal-h" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="screen-cal-h" className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Schedule for {screen.name}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400">Its own entries, those of its groups and those for every screen. Where two meet the higher priority shows.</p>
        </div>
        {month ? (
          <div className="flex items-center gap-2">
            <button type="button" className={btnCls} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={btnCls}
              onClick={() => {
                if (!today) return;
                setMonth(monthKey(today));
                setSelected(today);
              }}
            >
              Today
            </button>
            <button type="button" className={btnCls} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
            <h3 className="min-w-[10rem] text-lg font-semibold text-slate-900 dark:text-slate-100" aria-live="polite">
              {monthTitle(month)}
            </h3>
          </div>
        ) : null}
      </div>

      {entries === null || !tz || !month ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : (
        <>
          <MonthGrid month={month} grid={grid} days={days} today={today!} selected={selected} onSelect={setSelected} onPick={pick} canEdit={perms.write} onAdd={(day) => open(null, { kind: "new", day, screenId: screen.id })} />
          <MonthAgenda month={month} grid={grid} days={days} today={today!} onPick={pick} />
          {selected ? <DayPanel day={selected} items={days.get(selected) ?? []} tz={tz} canEdit={perms.write} onEdit={(e) => open(e)} onAdd={() => open(null, { kind: "new", day: selected, screenId: screen.id })} /> : null}
          <p className="text-xs text-slate-500 dark:text-slate-400">Times are on the site&apos;s clock ({tz}).</p>
        </>
      )}

      {editing && tz ? (
        <ScheduleModal
          initial={editing.entry}
          start={editing.start}
          tz={tz}
          screens={screens.data ?? []}
          groups={groups.data ?? []}
          playlists={playlists.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}
    </section>
  );
}
