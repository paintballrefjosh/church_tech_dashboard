"use client";

import { useId, useState } from "react";
import { SIGNAGE_MONTH_WEEKS, SIGNAGE_PRIORITIES, SIGNAGE_PRIORITY_DEFAULT, localDate, type SignagePlaylist, type SignageSchedule, type SignageScheduleKind, type SignageScreen, type SignageScreenGroup } from "@lampstand/shared";
import { sendJson } from "@/components/assets-ui";
import { Modal } from "../../monitoring/network-cisco/cisco-ui";
import { DayPicker, ErrorLine, Label, PlaylistSelect, TargetPicker, btnCls, dangerCls, inputCls, primaryCls } from "../signage-ui";
import { addDays, hmOf, siteInstant, ymdOf } from "./schedule-model";

/** How the dialog opens: editing, a new entry (on a picked day), or the "notice on every screen now" shortcut. */
export type ModalStart = { kind: "new"; day?: string; screenId?: string } | { kind: "urgent" };

const WEEK_WORDS: Record<number, string> = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth", [-1]: "Last" };

function nextHour(tz: string): { day: string; hm: string } {
  const t = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  return { day: ymdOf(t, tz), hm: hmOf(t, tz) };
}

export function ScheduleModal({
  initial,
  start,
  tz,
  screens,
  groups,
  playlists,
  onClose,
  onSaved,
}: {
  initial: SignageSchedule | null;
  start: ModalStart;
  tz: string;
  screens: SignageScreen[];
  groups: SignageScreenGroup[];
  playlists: SignagePlaylist[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const id = useId();
  const urgent = !initial && start.kind === "urgent";
  // Defaults for a new one-time entry: the picked day (or today) at the next hour, for two hours; a notice starts now.
  const nowMs = Date.now();
  const nh = nextHour(tz);
  const pickedDay = start.kind === "new" && start.day ? start.day : null;
  const defStartDay = urgent ? ymdOf(nowMs, tz) : (pickedDay && pickedDay !== nh.day ? pickedDay : nh.day);
  const defStartHm = urgent ? hmOf(nowMs, tz) : pickedDay && pickedDay !== nh.day ? "09:00" : nh.hm;
  const defEnd = Date.parse(siteInstant(defStartDay, defStartHm, tz)) + 2 * 3_600_000;

  const [name, setName] = useState(initial?.name ?? (urgent ? "Notice" : ""));
  const [kind, setKind] = useState<SignageScheduleKind>(initial?.kind ?? (urgent || pickedDay ? "once" : "weekly"));
  const [targetType, setTargetType] = useState<"screen" | "group" | "all">(initial?.targetType ?? (urgent ? "all" : "screen"));
  const [targetId, setTargetId] = useState<string | null>(initial?.targetId ?? (start.kind === "new" ? (start.screenId ?? null) : null));
  const [playlistId, setPlaylistId] = useState<string | null>(initial?.playlistId ?? null);
  const [startDay, setStartDay] = useState(initial?.startsAt ? ymdOf(Date.parse(initial.startsAt), tz) : defStartDay);
  const [startHm, setStartHm] = useState(initial?.startsAt ? hmOf(Date.parse(initial.startsAt), tz) : defStartHm);
  const [endDay, setEndDay] = useState(initial?.endsAt ? ymdOf(Date.parse(initial.endsAt), tz) : ymdOf(defEnd, tz));
  const [endHm, setEndHm] = useState(initial?.endsAt ? hmOf(Date.parse(initial.endsAt), tz) : hmOf(defEnd, tz));
  const [repeat, setRepeat] = useState<"weekly" | "monthly">(initial?.kind === "monthly" ? "monthly" : "weekly");
  const [days, setDays] = useState<number[]>(initial?.daysOfWeek.length ? initial.daysOfWeek : [7]);
  const [weeks, setWeeks] = useState<number[]>(initial?.monthWeeks ?? [1]);
  const [startTime, setStartTime] = useState(initial?.startTime ?? "08:00");
  const [endTime, setEndTime] = useState(initial?.endTime ?? "13:00");
  const [firstDay, setFirstDay] = useState(initial?.startDate ?? "");
  const [lastDay, setLastDay] = useState(initial?.endDate ?? "");
  const [priority, setPriority] = useState(initial?.priority ?? (urgent ? 5 : SIGNAGE_PRIORITY_DEFAULT));
  const [forcePowerOn, setForcePowerOn] = useState(initial?.forcePowerOn ?? urgent);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const once = kind === "once";
  const effectiveKind: SignageScheduleKind = once ? "once" : repeat;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const base = { name: name.trim(), kind: effectiveKind, targetType, targetId: targetType === "all" ? null : targetId, playlistId, priority, forcePowerOn, enabled };
    const body = once
      ? { ...base, startsAt: siteInstant(startDay, startHm, tz), endsAt: siteInstant(endDay, endHm, tz) }
      : { ...base, daysOfWeek: days, monthWeeks: effectiveKind === "monthly" ? weeks : null, startTime, endTime, startDate: firstDay || null, endDate: lastDay || null };
    setBusy(true);
    try {
      if (initial) await sendJson(`/api/signage/schedules/${initial.id}`, "PATCH", body);
      else await sendJson("/api/signage/schedules", "POST", body);
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!initial || !window.confirm(`Delete ${initial.name}?`)) return;
    try {
      await sendJson(`/api/signage/schedules/${initial.id}`, "DELETE");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }
  async function endNow() {
    if (!initial || !window.confirm(`End ${initial.name} now? The screens go back to the rest of the schedule.`)) return;
    try {
      await sendJson(`/api/signage/schedules/${initial.id}/end`, "POST");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  }

  const missing = !name.trim() || !playlistId || (targetType !== "all" && !targetId) || (!once && (!days.length || (repeat === "monthly" && !weeks.length)));
  const today = localDate(Date.now(), tz);

  return (
    <Modal title={initial ? `Edit ${initial.name}` : urgent ? "Notice on every screen" : "Add to the schedule"} onClose={onClose}>
      <form onSubmit={submit} className="max-h-[75vh] space-y-3 overflow-y-auto pr-1">
        {urgent ? <p className="text-sm text-slate-700 dark:text-slate-200">Every screen shows this playlist from now until the end time, at the highest priority, and TVs that are off are switched on.</p> : null}
        <div>
          <Label htmlFor={`${id}-n`}>Name</Label>
          <input id={`${id}-n`} className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={once ? "Smith wedding" : "Sunday morning"} maxLength={120} required />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-p`}>Playlist</Label>
            <PlaylistSelect id={`${id}-p`} value={playlistId} onChange={setPlaylistId} playlists={playlists} />
          </div>
          <div>
            <Label htmlFor={`${id}-t`}>Screens</Label>
            <TargetPicker
              id={`${id}-t`}
              targetType={targetType}
              targetId={targetId}
              onChange={(t, tid) => {
                setTargetType(t);
                setTargetId(tid);
              }}
              screens={screens}
              groups={groups}
              allowAll
            />
          </div>
        </div>

        <fieldset>
          <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Happens</legend>
          <div className="mt-1 inline-flex rounded-md border border-slate-300 p-0.5 dark:border-slate-700">
            {(
              [
                ["once", "One time"],
                ["repeat", "Repeats"],
              ] as const
            ).map(([v, label]) => {
              const on = v === "once" ? once : !once;
              return (
                <label key={v} className={`inline-flex min-h-[30px] cursor-pointer items-center rounded px-3 text-sm ${on ? "bg-brand-600 text-white" : "text-slate-700 dark:text-slate-200"} has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-500`}>
                  <input type="radio" name={`${id}-kind`} className="sr-only" checked={on} onChange={() => setKind(v === "once" ? "once" : repeat)} />
                  {label}
                </label>
              );
            })}
          </div>
        </fieldset>

        {once ? (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor={`${id}-sd`}>Starts on</Label>
              <input
                id={`${id}-sd`}
                type="date"
                className={inputCls}
                value={startDay}
                onChange={(e) => {
                  const v = e.target.value;
                  // Keep the length when the start day moves (a common edit), unless the end was already later.
                  if (v && endDay < v) setEndDay(v);
                  setStartDay(v);
                }}
                required
              />
            </div>
            <div>
              <Label htmlFor={`${id}-st`}>at</Label>
              <input id={`${id}-st`} type="time" className={inputCls} value={startHm} onChange={(e) => setStartHm(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor={`${id}-ed`}>Ends on</Label>
              <input id={`${id}-ed`} type="date" className={inputCls} value={endDay} min={startDay} onChange={(e) => setEndDay(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor={`${id}-et`}>at</Label>
              <input id={`${id}-et`} type="time" className={inputCls} value={endHm} onChange={(e) => setEndHm(e.target.value)} required />
            </div>
            {endDay === startDay && endHm <= startHm ? (
              <p className="col-span-2 text-xs text-slate-600 dark:text-slate-300">
                The end is before the start. To run past midnight, end on {addDays(startDay, 1)}.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor={`${id}-ft`}>From</Label>
                <input id={`${id}-ft`} type="time" className={inputCls} value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
              </div>
              <div>
                <Label htmlFor={`${id}-ut`} hint="Earlier than the start = runs past midnight.">
                  Until
                </Label>
                <input id={`${id}-ut`} type="time" className={inputCls} value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
              </div>
            </div>
            <div className="max-w-[16rem]">
              <Label htmlFor={`${id}-r`}>Repeat</Label>
              <select
                id={`${id}-r`}
                className={inputCls}
                value={repeat}
                onChange={(e) => {
                  const v = e.target.value as "weekly" | "monthly";
                  setRepeat(v);
                  setKind(v);
                }}
              >
                <option value="weekly">Every week</option>
                <option value="monthly">Some weeks of the month</option>
              </select>
            </div>
            {repeat === "monthly" ? <WeekPicker idPrefix={id} value={weeks} onChange={setWeeks} /> : null}
            <DayPicker idPrefix={id} value={days} onChange={setDays} />
            {repeat === "monthly" && weeks.length && days.length ? (
              <p className="text-xs text-slate-600 dark:text-slate-300">
                For example the {weeks.map((w) => WEEK_WORDS[w]!.toLowerCase()).join(" and ")} {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][days[0]! - 1]} of each month.
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor={`${id}-fd`}>Starting (optional)</Label>
                <input id={`${id}-fd`} type="date" className={inputCls} value={firstDay} onChange={(e) => setFirstDay(e.target.value)} />
              </div>
              <div>
                <Label htmlFor={`${id}-ld`}>Ending (optional)</Label>
                <input id={`${id}-ld`} type="date" className={inputCls} value={lastDay} min={firstDay || undefined} onChange={(e) => setLastDay(e.target.value)} />
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${id}-pr`} hint="Where two entries meet on a screen, the higher shows. Two at the same priority cannot overlap.">
              Priority
            </Label>
            <select id={`${id}-pr`} className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {[...SIGNAGE_PRIORITIES].reverse().map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col justify-end gap-2">
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={forcePowerOn} onChange={(e) => setForcePowerOn(e.target.checked)} /> Switch the TVs on for it
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> On
            </label>
          </div>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400">Dates and times are on the site&apos;s clock ({tz}).</p>
        <ErrorLine text={err} />
        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            {initial ? (
              <button type="button" className={dangerCls} onClick={() => void remove()}>
                Delete
              </button>
            ) : null}
            {initial?.kind === "once" && initial.state !== "ended" && initial.startsAt && (initial.state === "active" || ymdOf(Date.parse(initial.startsAt), tz) >= today) ? (
              <button type="button" className={dangerCls} onClick={() => void endNow()}>
                {initial.state === "active" ? "End now" : "Cancel it"}
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <button type="button" className={btnCls} onClick={onClose}>
              Close
            </button>
            <button type="submit" className={primaryCls} disabled={missing || busy}>
              Save
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** First / Second / Third / Fourth / Last: which weeks of the month a monthly entry repeats on. */
function WeekPicker({ value, onChange, idPrefix }: { value: number[]; onChange: (v: number[]) => void; idPrefix: string }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-slate-700 dark:text-slate-200">Weeks of the month</legend>
      <div className="mt-1 flex flex-wrap gap-1">
        {SIGNAGE_MONTH_WEEKS.map((w) => {
          const on = value.includes(w);
          return (
            <label
              key={w}
              htmlFor={`${idPrefix}-w${w}`}
              className={`inline-flex min-h-[32px] min-w-[44px] cursor-pointer items-center justify-center rounded-md border px-2 text-sm has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-500 ${
                on ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-200"
              }`}
            >
              <input id={`${idPrefix}-w${w}`} type="checkbox" className="sr-only" checked={on} onChange={() => onChange(on ? value.filter((x) => x !== w) : [...value, w])} />
              {WEEK_WORDS[w]}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
