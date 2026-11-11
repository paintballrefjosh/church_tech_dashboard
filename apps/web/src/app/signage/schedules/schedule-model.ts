import { localDate, scheduleWindows, zonedParts, zonedTimeToUtc, type SignageSchedule, type SignageScreen } from "@lampstand/shared";

/**
 * The Schedule page's arithmetic (docs/signage.md section 9): which entries are on which day of a month, on the site's clock.
 * Pure, so it is unit-tested (`schedule-model.test.ts`). Calendar days are "YYYY-MM-DD" strings; instants are milliseconds.
 */

export interface Occurrence {
  entry: SignageSchedule;
  start: number;
  end: number;
  /** Local day it starts and the last local day it covers. */
  firstDay: string;
  lastDay: string;
  startHm: string;
  endHm: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function ymdOf(ms: number, tz: string): string {
  return localDate(ms, tz);
}

export function hmOf(ms: number, tz: string): string {
  const p = zonedParts(new Date(ms), tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** Calendar arithmetic on "YYYY-MM-DD" (no time zone involved: a date is a date). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function monthKey(day: string): string {
  return day.slice(0, 7);
}

export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1 + n, 1));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}

/** The days a month grid shows: whole weeks, Sunday first, from the week holding the 1st to the week holding the last day. */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`;
  const start = addDays(first, -weekdayOf(first));
  const lastOfMonth = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDays(lastOfMonth, 6 - weekdayOf(lastOfMonth));
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Midnight at the start of `day` on the site's clock. */
export function dayStart(day: string, tz: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return zonedTimeToUtc(tz, y!, m!, d!, 0, 0).getTime();
}

/** Does an entry apply to the screen or group picked in the "Show" filter? A screen sees its own, its groups' and all-screens entries. */
export function entryMatches(e: SignageSchedule, focus: string, screens: SignageScreen[]): boolean {
  if (!focus) return true;
  const [type, id] = focus.split(":");
  if (e.targetType === "all") return true;
  if (type === "group") return e.targetType === "group" && e.targetId === id;
  const sc = screens.find((x) => x.id === id);
  return (e.targetType === "screen" && e.targetId === id) || (e.targetType === "group" && !!e.targetId && !!sc?.groupIds.includes(e.targetId));
}

/** Every time an entry is on between the start of `firstDay` and the end of `lastDay`, on the site's clock. Switched-off entries are INCLUDED (the calendar draws them greyed, `entry.enabled` is false) so they can be found and switched back on. */
export function occurrences(entries: SignageSchedule[], firstDay: string, lastDay: string, tz: string): Occurrence[] {
  const from = new Date(dayStart(firstDay, tz));
  const to = new Date(dayStart(addDays(lastDay, 1), tz));
  const out: Occurrence[] = [];
  for (const e of entries) {
    const rule = { ...e, startsAt: e.startsAt ? new Date(e.startsAt) : null, endsAt: e.endsAt ? new Date(e.endsAt) : null };
    for (const iv of scheduleWindows(rule, from, to, tz)) {
      // The last day it covers: an end at exactly midnight belongs to the day before.
      out.push({ entry: e, start: iv.start, end: iv.end, firstDay: ymdOf(iv.start, tz), lastDay: ymdOf(iv.end - 1, tz), startHm: hmOf(iv.start, tz), endHm: hmOf(iv.end, tz) });
    }
  }
  return out.sort((a, b) => a.start - b.start || b.entry.priority - a.entry.priority || a.entry.name.localeCompare(b.entry.name));
}

/** Occurrences by the days they cover (a three-day conference is listed on each of its days). */
export function byDay(occ: Occurrence[]): Map<string, Occurrence[]> {
  const m = new Map<string, Occurrence[]>();
  for (const o of occ) for (let d = o.firstDay; d <= o.lastDay; d = addDays(d, 1)) m.set(d, [...(m.get(d) ?? []), o]);
  return m;
}

/** "08:00-12:00", or for a day in the middle or at the end of a longer entry "all day" / "until 14:00". */
export function timeOnDay(o: Occurrence, day: string): string {
  const starts = o.firstDay === day;
  const ends = o.lastDay === day;
  if (starts && ends) return `${o.startHm}-${o.endHm}`;
  if (starts) return `from ${o.startHm}`;
  if (ends) return o.endHm === "00:00" ? "all day" : `until ${o.endHm}`;
  return "all day";
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS[m! - 1]} ${y}`;
}

export function dayTitle(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${WEEKDAYS[weekdayOf(day)]} ${d} ${MONTHS[m! - 1]}`;
}

/** A date and time typed on the site's clock as an instant. */
export function siteInstant(day: string, hm: string, tz: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const [h, mi] = hm.split(":").map(Number);
  return zonedTimeToUtc(tz, y!, m!, d!, h!, mi!).toISOString();
}
