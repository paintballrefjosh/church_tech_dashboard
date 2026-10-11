import { calendarDaysBetween, formatTimeInZone, formatWeekdayInZone } from "@church/shared";
import { useEffect, useState } from "react";

/** The current time, starting from the server's clock so the first render matches the server's. */
export function useNow(serverNow: string, stepMs: number): Date {
  const [now, setNow] = useState<Date>(() => new Date(serverNow));
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), stepMs);
    return () => clearInterval(t);
  }, [stepMs]);
  return now;
}

/** "6:02 pm" for today, "Tue" within the week, "3 Oct" beyond. */
export function alertWhen(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(at, now, tz);
  if (days <= 0) return formatTimeInZone(at, tz);
  if (days < 7) return formatWeekdayInZone(at, tz).slice(0, 3);
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(at);
}

/** "Today", "Tomorrow" or the weekday, then "Sun 11 Oct". */
export function serviceDateLine(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(now, at, tz);
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  if (days <= 0) return `Today, ${date}`;
  if (days === 1) return `Tomorrow, ${date}`;
  return date;
}

/** "Wed 14 Oct at 7:00 pm". */
export function eventWhen(at: Date, tz: string): string {
  const date = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(at);
  return `${date} at ${formatTimeInZone(at, tz)}`;
}

/** "9:40 pm" today, "9:40 pm Friday" later. */
export function dueWhen(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(now, at, tz);
  const time = formatTimeInZone(at, tz);
  return days <= 0 ? time : `${time} ${formatWeekdayInZone(at, tz)}`;
}
