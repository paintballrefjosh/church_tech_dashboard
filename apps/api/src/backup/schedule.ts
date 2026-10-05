import type { BackupFrequency } from "@church/shared";

/**
 * When a backup schedule is next due. A schedule says "every day / week / month at 02:30 in
 * Europe/London", so the answer depends on the zone's daylight saving: worked out with Intl
 * alone (no date library is installed).
 */
export interface ScheduleSpec {
  frequency: BackupFrequency;
  /** `HH:MM` local time. */
  time: string;
  /** 0 = Sunday ... 6 = Saturday (weekly). */
  dayOfWeek: number;
  /** 1-28 (monthly). */
  dayOfMonth: number;
  timezone: string;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timezone: string): Intl.DateTimeFormat {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timezone, f);
  }
  return f;
}

/** The wall-clock fields `timezone` shows at the instant `ms`. */
function localParts(timezone: string, ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts: Record<string, number> = {};
  for (const p of formatter(timezone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  return { y: parts.year!, mo: parts.month!, d: parts.day!, h: parts.hour! % 24, mi: parts.minute!, s: parts.second! };
}

/** How far `timezone` is ahead of UTC at the instant `ms`. */
function offsetMs(timezone: string, ms: number): number {
  const p = localParts(timezone, ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The instant at which `timezone`'s clocks read the given local date and time. */
export function zonedToUtc(timezone: string, y: number, mo: number, d: number, h: number, mi: number): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = offsetMs(timezone, guess);
  let utc = guess - first;
  const second = offsetMs(timezone, utc);
  if (second !== first) utc = guess - second; // the guess was across a daylight saving change
  return new Date(utc);
}

/** The first run strictly after `after`. */
export function nextRunAfter(spec: ScheduleSpec, after: Date): Date {
  const [hh, mm] = spec.time.split(":").map(Number) as [number, number];
  const start = localParts(spec.timezone, after.getTime());
  for (let add = 0; add < 800; add++) {
    // Calendar arithmetic on the local date, done in UTC so it never meets a daylight saving jump.
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + add));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (spec.frequency === "weekly" && day.getUTCDay() !== spec.dayOfWeek) continue;
    if (spec.frequency === "monthly" && d !== spec.dayOfMonth) continue;
    const at = zonedToUtc(spec.timezone, y, mo, d, hh, mm);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new Error("could not work out the next run");
}
