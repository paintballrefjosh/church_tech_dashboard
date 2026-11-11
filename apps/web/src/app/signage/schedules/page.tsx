"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CalendarDays, CalendarRange, ChevronLeft, ChevronRight, List, Megaphone, Plus, Power } from "lucide-react";
import { localDate, type SignagePlaylist, type SignageSchedule, type SignageScreen, type SignageScreenGroup } from "@lampstand/shared";
import { PageTitle } from "@/components/page-title";
import { sendJson } from "@/components/assets-ui";
import { usePoll } from "@/lib/use-poll";
import { Forbidden, Label, btnCls, inputCls, primaryCls, dangerCls, targetText, useSignageJson, useSignagePerms } from "../signage-ui";
import { ScheduleModal, type ModalStart } from "./schedule-form";
import { byDay, entryMatches, monthGrid, monthKey, monthTitle, occurrences, shiftMonth, type Occurrence } from "./schedule-model";
import { DayPanel, MonthAgenda, MonthGrid, PriorityBadge, whenText } from "./schedule-calendar";

const VIEW_KEY = "lampstand_signage_schedule_view";

/** One schedule for everything a screen shows: one-time entries and weekly or monthly repeats, drawn as a month calendar. */
export default function SignageSchedulePage() {
  const perms = useSignagePerms();
  const [entries, setEntries] = useState<SignageSchedule[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const summary = useSignageJson<{ timezone: string }>("summary");
  const screens = useSignageJson<SignageScreen[]>("screens");
  const groups = useSignageJson<SignageScreenGroup[]>("groups");
  const playlists = useSignageJson<SignagePlaylist[]>("playlists");
  const tz = summary.data?.timezone ?? null;
  const [view, setView] = useState<"month" | "list">("month");
  const [month, setMonth] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  const [editing, setEditing] = useState<{ entry: SignageSchedule | null; start: ModalStart } | null>(null);
  const focusId = useId();

  const load = async () => {
    const r = await fetch("/api/signage/schedules", { credentials: "same-origin", cache: "no-store" });
    if (r.status === 403) return setForbidden(true);
    if (r.ok) setEntries((await r.json()) as SignageSchedule[]);
  };
  usePoll(load, 60_000);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(VIEW_KEY) === "list") setView("list");
    } catch {
      // Storage can be blocked; the month view is the default anyway.
    }
  }, []);
  const chooseView = (v: "month" | "list") => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // Not remembered, that is all.
    }
  };

  const today = tz ? localDate(Date.now(), tz) : null;
  useEffect(() => {
    if (today && month === null) {
      setMonth(monthKey(today));
      setSelected(today);
    }
  }, [today, month]);

  const shown = useMemo(() => (entries ?? []).filter((e) => entryMatches(e, focus, screens.data ?? [])), [entries, focus, screens.data]);
  const grid = useMemo(() => (month ? monthGrid(month) : []), [month]);
  const days = useMemo(() => (tz && grid.length ? byDay(occurrences(shown, grid[0]!, grid[grid.length - 1]!, tz)) : new Map<string, Occurrence[]>()), [shown, grid, tz]);

  if (forbidden || entries === null && summary.forbidden) return <Forbidden />;

  const open = (entry: SignageSchedule | null, start: ModalStart = { kind: "new", day: selected ?? today ?? undefined }) => setEditing({ entry, start });
  const pick = (o: Occurrence, day: string) => {
    setSelected(day);
    if (perms.write) open(o.entry);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <PageTitle icon={CalendarRange}>Schedule</PageTitle>
          <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">
            What each screen shows and when: one-time entries (a wedding, a conference, a notice) and weekly or monthly repeats. Where two meet on a screen the higher priority shows, and two at the same
            priority cannot overlap. Outside every entry a screen shows its fallback playlist.
          </p>
        </div>
        {perms.write ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={dangerCls} onClick={() => open(null, { kind: "urgent" })}>
              <Megaphone className="h-4 w-4" aria-hidden /> Notice on every screen now
            </button>
            <button type="button" className={primaryCls} onClick={() => open(null)}>
              <Plus className="h-4 w-4" aria-hidden /> Add to the schedule
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label="View" className="inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700">
            {(
              [
                ["month", "Month", CalendarDays],
                ["list", "List", List],
              ] as const
            ).map(([v, label, Icon]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => chooseView(v)}
                className={`inline-flex min-h-[30px] items-center gap-1.5 rounded px-3 text-sm ${view === v ? "bg-brand-600 text-white" : "text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"}`}
              >
                <Icon className="h-4 w-4" aria-hidden /> {label}
              </button>
            ))}
          </div>
          <div className="min-w-[14rem]">
            <Label htmlFor={focusId}>Show</Label>
            <select id={focusId} className={inputCls} value={focus} onChange={(e) => setFocus(e.target.value)}>
              <option value="">Every screen and group</option>
              {(groups.data ?? []).map((g) => (
                <option key={g.id} value={`group:${g.id}`}>
                  Group: {g.name}
                </option>
              ))}
              {(screens.data ?? []).map((s) => (
                <option key={s.id} value={`screen:${s.id}`}>
                  {s.name} (with its groups)
                </option>
              ))}
            </select>
          </div>
        </div>
        {view === "month" && month ? (
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
            <h2 className="min-w-[10rem] text-lg font-semibold text-slate-900 dark:text-slate-100" aria-live="polite">
              {monthTitle(month)}
            </h2>
          </div>
        ) : null}
      </div>

      {entries === null || !tz || !month ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Loading…</p>
      ) : view === "list" ? (
        <ScheduleList entries={shown} tz={tz} canEdit={perms.write} onEdit={(e) => open(e)} />
      ) : (
        <>
          <MonthGrid month={month} grid={grid} days={days} today={today!} selected={selected} onSelect={setSelected} onPick={pick} canEdit={perms.write} onAdd={(day) => open(null, { kind: "new", day })} />
          <MonthAgenda month={month} grid={grid} days={days} today={today!} onPick={pick} />
          {selected ? <DayPanel day={selected} items={days.get(selected) ?? []} tz={tz} canEdit={perms.write} onEdit={(e) => open(e)} onAdd={() => open(null, { kind: "new", day: selected })} /> : null}
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
    </div>
  );
}

function ScheduleList({ entries, tz, canEdit, onEdit }: { entries: SignageSchedule[]; tz: string; canEdit: boolean; onEdit: (e: SignageSchedule) => void }) {
  const [showEnded, setShowEnded] = useState(false);
  const rows = entries
    .filter((e) => showEnded || e.state !== "ended")
    .sort((a, b) => (a.kind === "once" ? 0 : 1) - (b.kind === "once" ? 0 : 1) || (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.name.localeCompare(b.name));
  const ended = entries.filter((e) => e.state === "ended").length;
  return (
    <div className="space-y-3">
      {ended ? (
        <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> Show {ended} that {ended === 1 ? "is" : "are"} over
        </label>
      ) : null}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Every schedule entry">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Every schedule entry</caption>
          <thead>
            <tr className="border-b border-slate-300 text-left text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
              <th className="py-2 pr-2">Name</th>
              <th className="py-2 pr-2">Shows</th>
              <th className="py-2 pr-2">On</th>
              <th className="py-2 pr-2">When</th>
              <th className="py-2 pr-2">Priority</th>
              <th className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="border-b border-slate-200 align-top dark:border-slate-800">
                <td className="py-2 pr-2 text-slate-900 dark:text-slate-100">
                  {e.name}
                  {!e.enabled ? <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">(off)</span> : null}
                  {e.state === "active" ? <span className="ml-1 rounded bg-brand-100 px-1.5 py-0.5 text-xs text-brand-800 dark:bg-brand-900 dark:text-brand-100">Showing now</span> : null}
                  {e.state === "ended" ? <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">(over)</span> : null}
                  {e.forcePowerOn ? <Power className="ml-1 inline h-3.5 w-3.5 text-slate-500 dark:text-slate-400" aria-label="Switches TVs on" /> : null}
                </td>
                <td className="py-2 pr-2">{e.playlistName}</td>
                <td className="py-2 pr-2">{targetText(e)}</td>
                <td className="py-2 pr-2">{whenText(e, tz)}</td>
                <td className="py-2 pr-2">
                  <PriorityBadge p={e.priority} />
                </td>
                <td className="py-2 text-right">
                  {canEdit ? (
                    <button type="button" className={btnCls} onClick={() => onEdit(e)} aria-label={`Edit ${e.name}`}>
                      Edit
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-4 text-center text-slate-500 dark:text-slate-400">
                  Nothing on the schedule.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

