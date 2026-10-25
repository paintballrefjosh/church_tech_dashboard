import { zonedParts } from "./dashboard/zoned";

/**
 * When a monitor is checked at all: `options.schedule`, a list of weekly windows on the SITE's clock, for equipment that is
 * only meant to be on during services (a livestream, a projector, a recorder). Outside every window the probe worker does
 * not probe and records a healthy "outside its hours" check instead, so an incident left open at the end of a service
 * closes and nobody is paged at 3am on a Tuesday because the stream is off. No schedule = always checked.
 *
 * Format: windows separated by ";" or new lines, each `<days> <HH:MM>-<HH:MM>`, days as `Sun`, `Sun,Wed` or `Mon-Fri`
 * (three-letter English names). A window may cross midnight (`Sat 22:00-02:00` runs into Sunday). Unit-tested in
 * apps/api/test/monitor-schedule.test.ts; parsed the same way in the API (to refuse a bad one) and in the worker.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export interface ScheduleWindow {
  /** ISO weekdays, 1 = Monday .. 7 = Sunday. */
  days: number[];
  start: number; // minutes after midnight
  end: number; // minutes after midnight; < start = crosses midnight
}

function dayIndex(name: string): number {
  const i = DAYS.findIndex((d) => d.toLowerCase() === name.trim().slice(0, 3).toLowerCase());
  if (i < 0) throw new Error(`"${name.trim()}" is not a day (use Mon, Tue, Wed, Thu, Fri, Sat, Sun)`);
  return i + 1;
}

function clock(s: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) throw new Error(`"${s.trim()}" is not a time (use HH:MM, 24-hour)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Parse a schedule; throws with a message for a person when it cannot be read. Empty text = no windows. */
export function parseMonitorSchedule(text: string): ScheduleWindow[] {
  const out: ScheduleWindow[] = [];
  for (const raw of text.split(/[;\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = /^(\S+)\s+(\S+)\s*-\s*(\S+)$/.exec(part);
    if (!m) throw new Error(`"${part}" should look like "Sun 08:00-13:00"`);
    const days = new Set<number>();
    for (const d of m[1]!.split(",")) {
      const range = d.split("-");
      if (range.length === 2) {
        let a = dayIndex(range[0]!);
        const b = dayIndex(range[1]!);
        for (let guard = 0; guard < 7; guard++) {
          days.add(a);
          if (a === b) break;
          a = (a % 7) + 1;
        }
      } else {
        days.add(dayIndex(d));
      }
    }
    const start = clock(m[2]!);
    const end = clock(m[3]!);
    if (start === end) throw new Error(`"${part}" starts and ends at the same time`);
    out.push({ days: [...days].sort(), start, end });
  }
  return out;
}

/** The problem with a schedule for the API to report, or null when it reads (or is empty). */
export function monitorScheduleProblem(text: unknown): string | null {
  if (text === undefined || text === null || text === "") return null;
  if (typeof text !== "string") return "The schedule must be text.";
  if (text.length > 500) return "The schedule is too long.";
  try {
    parseMonitorSchedule(text);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** Whether `now` falls in one of the windows, on the clock of `tz`. No windows = always. */
export function monitorScheduleActive(windows: ScheduleWindow[], now: Date, tz: string): boolean {
  if (windows.length === 0) return true;
  const p = zonedParts(now, tz);
  const minute = p.hour * 60 + p.minute;
  const yesterday = p.weekday === 1 ? 7 : p.weekday - 1;
  return windows.some((w) => {
    if (w.start < w.end) return w.days.includes(p.weekday) && minute >= w.start && minute < w.end;
    // Crosses midnight: the evening part on the day named, the morning part on the day after.
    return (w.days.includes(p.weekday) && minute >= w.start) || (w.days.includes(yesterday) && minute < w.end);
  });
}
