import { calendarDaysBetween, formatTimeInZone, formatWeekdayInZone, zonedParts } from "@church/shared";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * "Sun 11 Oct" and "11 Oct", built by hand from the zone's calendar fields: Intl's punctuation
 * differs between Node's and the browser's ICU, which is a hydration mismatch.
 */
function dayText(at: Date, tz: string, withWeekday: boolean): string {
  const p = zonedParts(at, tz);
  const date = `${p.day} ${MONTHS[p.month - 1] ?? ""}`;
  if (!withWeekday) return date;
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return `${WEEKDAYS[dow] ?? ""} ${date}`;
}

/** "6:02 pm" for today, "Tue" within the week, "3 Oct" beyond. */
export function alertWhen(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(at, now, tz);
  if (days <= 0) return formatTimeInZone(at, tz);
  if (days < 7) return formatWeekdayInZone(at, tz).slice(0, 3);
  return dayText(at, tz, false);
}

/** "Today", "Tomorrow" or the weekday, then "Sun 11 Oct". */
export function serviceDateLine(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(now, at, tz);
  const date = dayText(at, tz, true);
  if (days <= 0) return `Today, ${date}`;
  if (days === 1) return `Tomorrow, ${date}`;
  return date;
}

/** "Wed 14 Oct at 7:00 pm". */
export function eventWhen(at: Date, tz: string): string {
  const date = dayText(at, tz, true);
  return `${date} at ${formatTimeInZone(at, tz)}`;
}

/** "9:40 pm" today, "9:40 pm Friday" later. */
export function dueWhen(at: Date, now: Date, tz: string): string {
  const days = calendarDaysBetween(now, at, tz);
  const time = formatTimeInZone(at, tz);
  return days <= 0 ? time : `${time} ${formatWeekdayInZone(at, tz)}`;
}
