/**
 * Calendar maths in an IANA time zone, using `Intl.DateTimeFormat` only (no dependency).
 *
 * The rule throughout: a "day" is a calendar day on the wall clock of the zone, so on a
 * daylight-saving change it is 23 or 25 hours long, never a fixed 24. Everything here takes the
 * zone explicitly; nothing reads the machine's own zone.
 */

export interface ZonedParts {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
  /** 0 to 23. */
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** The wall-clock fields of `date` in `tz`. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    // Some engines print midnight as "24" even with h23.
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS[out.weekday ?? ""] ?? 1,
  };
}

/** Offset of `tz` from UTC at the instant `ms`, in milliseconds (positive east of Greenwich). */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which the wall clock of `tz` reads the given fields. `month` and `day` may
 * overflow (Date.UTC normalises them). A time that does not exist (the hour skipped in spring)
 * resolves to the instant just after the gap; an ambiguous one (the repeated hour in autumn)
 * resolves to its first occurrence.
 */
export function zonedTimeToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  // Try both offsets that could apply around the wall time and keep the one that round-trips.
  const o1 = offsetAt(wall - 12 * 3_600_000, tz);
  const o2 = offsetAt(wall + 12 * 3_600_000, tz);
  const candidates = o1 === o2 ? [wall - o1] : [wall - o1, wall - o2];
  const valid = candidates.filter((c) => offsetAt(c, tz) === wall - c);
  if (valid.length > 0) return new Date(Math.min(...valid));
  // In the gap: neither offset reproduces the wall time. Use the offset from before the change,
  // which lands just after the gap on the new clock.
  return new Date(wall - o1);
}

/** Midnight at the start of the calendar day containing `date`, in `tz`. */
export function startOfDayInZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(tz, p.year, p.month, p.day);
}

/** Midnight at the start of the Monday of the week containing `date`, in `tz`. */
export function startOfWeekInZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(tz, p.year, p.month, p.day - (p.weekday - 1));
}

/**
 * `date` moved by `days` calendar days, keeping the same wall-clock time of day (so it is not
 * always `days * 24` hours later). Negative values go back.
 */
export function addDaysInZone(date: Date, tz: string, days: number): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(tz, p.year, p.month, p.day + days, p.hour, p.minute, p.second);
}

/**
 * `count` consecutive hour starts. The first is the start of the wall-clock hour containing
 * `date`; each next one is one real hour later (a zone's offset is a multiple of a quarter hour,
 * so wall-clock hours in half-hour zones start at :30 UTC, which this respects).
 */
export function hourStartsInZone(date: Date, tz: string, count: number): Date[] {
  const p = zonedParts(date, tz);
  const first = Math.floor(date.getTime() / 1000) * 1000 - (p.minute * 60 + p.second) * 1000;
  const out: Date[] = [];
  for (let i = 0; i < count; i++) out.push(new Date(first + i * 3_600_000));
  return out;
}

/** "9:40 pm" on the clock of `tz`. */
export function formatTimeInZone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(date)
    .replace(/\s/g, " ")
    .toLowerCase();
}

/** "Sunday" on the calendar of `tz`. */
export function formatWeekdayInZone(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long" }).format(date);
}

/** Whole calendar days from the day of `from` to the day of `to` in `tz` (0 = same day). */
export function calendarDaysBetween(from: Date, to: Date, tz: string): number {
  const a = zonedParts(from, tz);
  const b = zonedParts(to, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}
