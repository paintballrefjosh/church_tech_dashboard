import {
  addDaysInZone,
  calendarDaysBetween,
  formatWeekdayInZone,
  startOfDayInZone,
  zonedParts,
  type NextService,
  type WeekDigest,
} from "@church/shared";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const pad = (n: number) => String(n).padStart(2, "0");

/** "2026-10-11" on the calendar of `tz`. */
export function dateKey(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "10 October" on the calendar of `tz`. */
export function dayAndMonth(d: Date, tz: string): string {
  const p = zonedParts(d, tz);
  return `${p.day} ${MONTHS[p.month - 1] ?? ""}`;
}

/** The share of the calendar day (in `tz`) that has passed at `now`, 0 to 1. A DST day is 23 or 25 hours. */
export function dayFraction(now: Date, tz: string): number {
  const start = startOfDayInZone(now, tz);
  const end = addDaysInZone(start, tz, 1);
  const span = end.getTime() - start.getTime();
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (now.getTime() - start.getTime()) / span));
}

function parse(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** When the next service starts: its first service-kind time, else its own start. */
export function serviceStart(service: NextService): Date | null {
  const times = service.times
    .filter((t) => t.kind === "service")
    .map((t) => parse(t.startsAt))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return times[0] ?? parse(service.startsAt);
}

/** The instant the countdown runs to: the first service time still ahead, else the first one. */
export function countdownTarget(service: NextService, now: Date): Date | null {
  const times = service.times
    .filter((t) => t.kind === "service")
    .map((t) => parse(t.startsAt))
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime());
  return times.find((d) => d.getTime() > now.getTime()) ?? times[0] ?? parse(service.startsAt);
}

/** "is tomorrow", "is today", "is on Sunday", or for a later week "is on Sunday 18 October". */
export function whenPhrase(start: Date, now: Date, tz: string, title = ""): string {
  const days = calendarDaysBetween(now, start, tz);
  if (days <= 0) return "is today";
  if (days === 1) return "is tomorrow";
  const weekday = formatWeekdayInZone(start, tz);
  // A title that already names the weekday ("Wednesday Practice") must not be followed by it again.
  const repeats = title.toLowerCase().includes(weekday.toLowerCase());
  if (days < 7) return repeats ? `is in ${days} days` : `is on ${weekday}`;
  return repeats ? `is on ${dayAndMonth(start, tz)}` : `is on ${weekday} ${dayAndMonth(start, tz)}`;
}

/** Index (0 to 6) of the week day holding `at`, or -1 when it is not in this week. */
export function dayIndexOf(week: WeekDigest, at: Date | null, tz: string): number {
  if (!at) return -1;
  const key = dateKey(at, tz);
  return week.days.findIndex((d) => d.date === key);
}

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things"];

/** The one plain line under the readiness score. */
export function readinessLine(score: number, total: number, hasService: boolean): string {
  const left = total - score;
  if (left <= 0) return hasService ? "Everything is in place for the team." : "Everything checks out.";
  const what = WORDS[left] ?? `${left} things`;
  return hasService ? `${what} to sort before the team arrives.` : `${what} to sort.`;
}
