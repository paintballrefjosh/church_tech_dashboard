import type { WeekDigest } from "./home";
import { addDaysInZone, startOfWeekInZone, zonedParts, zonedTimeToUtc } from "./zoned";

type Day = WeekDigest["days"][number];
export type WeekEvent = Day["events"][number];
export type HealthCell = Day["health"][number];

/** Most events shown for one day; the rest are counted in `moreCount`. */
export const WEEK_EVENTS_PER_DAY = 3;

export interface WeekEventInput {
  kind: WeekEvent["kind"];
  title: string;
  detail: string | null;
  at: Date;
  tone: WeekEvent["tone"];
  href: string | null;
  /** Incidents of the same system on the same day collapse into one event. */
  group?: string;
  /** The system's name, for the collapsed incident title. */
  subject?: string;
  /** Incident length in ms; null while it is still open. */
  durationMs?: number | null;
}

/** One system's counters for one UTC hour (the shape of an `availability_hourly` row). */
export interface HealthRow {
  kind: string;
  ref: string;
  /** ISO string of the UTC hour start. */
  hour: string;
  samples: number;
  down: number;
}

export interface IncidentSpan {
  start: Date;
  /** Null while the incident is still open. */
  end: Date | null;
}

export interface WeekInput {
  now: Date;
  timezone: string;
  events: readonly WeekEventInput[];
  /** Null when the person may not see systems: every cell is "none". */
  health: { rows: readonly HealthRow[]; incidents: readonly IncidentSpan[] } | null;
}

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

const TONE_RANK: Record<WeekEvent["tone"], number> = { bad: 0, warn: 1, info: 2, ok: 3 };
const KIND_RANK: Record<WeekEvent["kind"], number> = {
  incident: 0,
  service: 1,
  checklist: 2,
  ticket: 3,
  backup: 4,
  wiki: 5,
};

/** "4 min", "2 h 10 min", "1 d 3 h". */
export function outageText(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return mins % 60 === 0 ? `${hours} h` : `${hours} h ${mins % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/**
 * Cuts the noise of one day: backups become a single event (the lowest priority), and incidents of
 * one system become a single "went down n times" event.
 */
export function collapseDayEvents(events: readonly WeekEventInput[]): WeekEventInput[] {
  const out: WeekEventInput[] = [];
  const incidents = new Map<string, WeekEventInput[]>();
  const backups: WeekEventInput[] = [];
  for (const e of events) {
    if (e.kind === "backup") backups.push(e);
    else if (e.kind === "incident" && e.group) {
      const list = incidents.get(e.group) ?? [];
      list.push(e);
      incidents.set(e.group, list);
    } else out.push(e);
  }
  for (const list of incidents.values()) {
    const first = [...list].sort((a, b) => a.at.getTime() - b.at.getTime())[0]!;
    if (list.length === 1) {
      out.push(first);
      continue;
    }
    const open = list.some((e) => e.durationMs === null);
    const longest = list.reduce((m, e) => Math.max(m, e.durationMs ?? 0), 0);
    out.push({
      ...first,
      title: `${first.subject ?? "A system"} went down ${list.length} times`,
      detail: open ? "Still down" : `Longest outage ${outageText(longest)}`,
      tone: open ? "bad" : "warn",
    });
  }
  if (backups.length === 1) out.push(backups[0]!);
  else if (backups.length > 1) {
    const failed = backups.filter((b) => b.tone === "bad").length;
    const latest = [...backups].sort((a, b) => b.at.getTime() - a.at.getTime())[0]!;
    out.push({
      ...latest,
      title: failed > 0 ? `${backups.length} backups, ${failed} failed` : `${backups.length} backups finished`,
      detail: null,
      tone: failed > 0 ? "bad" : "ok",
    });
  }
  return out;
}

/** Most important first: a problem, then a warning, then information; backups always last. */
export function compareWeekEvents(a: WeekEventInput, b: WeekEventInput): number {
  const backup = Number(a.kind === "backup") - Number(b.kind === "backup");
  if (backup !== 0) return backup;
  return (
    TONE_RANK[a.tone] - TONE_RANK[b.tone] ||
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    a.at.getTime() - b.at.getTime()
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The 24 hourly cells of one calendar day. Cell `i` is the wall-clock hour `i` of the zone (on a
 * daylight-saving day an hour is missing or repeated; the repeated hour folds into one cell and a
 * skipped hour shows "none").
 */
export function dayHealth(
  cellStarts: readonly Date[],
  dayEnd: Date,
  now: Date,
  health: NonNullable<WeekInput["health"]>,
  samplingStart: number | null,
): HealthCell[] {
  const nowMs = now.getTime();
  const out: HealthCell[] = [];
  for (let i = 0; i < cellStarts.length; i++) {
    const start = cellStarts[i]!.getTime();
    const end = (cellStarts[i + 1] ?? dayEnd).getTime();
    if (start > nowMs) {
      out.push("future");
      continue;
    }
    const perSystem = new Map<string, { samples: number; down: number }>();
    for (const r of health.rows) {
      const h = Date.parse(r.hour);
      if (h < start || h >= end) continue;
      const key = `${r.kind}\u0000${r.ref}`;
      const cur = perSystem.get(key) ?? { samples: 0, down: 0 };
      cur.samples += r.samples;
      cur.down += r.down;
      perSystem.set(key, cur);
    }
    let sampled = false;
    let anyDown = false;
    let majorityDown = false;
    for (const s of perSystem.values()) {
      if (s.samples <= 0) continue;
      sampled = true;
      if (s.down > 0) anyDown = true;
      if (s.down * 2 >= s.samples) majorityDown = true;
    }
    if (sampled) {
      out.push(majorityDown ? "down" : anyDown ? "partial" : "up");
      continue;
    }
    // No samples: only hours before sampling began fall back to the incident log.
    if (samplingStart === null || start < samplingStart) {
      const overlap = health.incidents.some(
        (inc) => inc.start.getTime() < end && (inc.end ? inc.end.getTime() : nowMs) > start,
      );
      out.push(overlap ? "down" : "none");
    } else out.push("none");
  }
  return out;
}

/** The Monday-to-Sunday week containing `now` in the zone, with its events and hourly health. */
export function buildWeek(input: WeekInput): WeekDigest {
  const { now, timezone: tz } = input;
  const weekStart = startOfWeekInZone(now, tz);
  const todayParts = zonedParts(now, tz);
  const today = `${todayParts.year}-${pad(todayParts.month)}-${pad(todayParts.day)}`;
  const samplingStart = input.health
    ? input.health.rows.reduce<number | null>((min, r) => {
        const h = Date.parse(r.hour);
        return min === null || h < min ? h : min;
      }, null)
    : null;

  const days: Day[] = [];
  const starts: Date[] = [];
  for (let i = 0; i <= 7; i++) starts.push(addDaysInZone(weekStart, tz, i));

  for (let i = 0; i < 7; i++) {
    const start = starts[i]!;
    const end = starts[i + 1]!;
    const p = zonedParts(start, tz);
    const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
    const here = collapseDayEvents(
      input.events.filter((e) => e.at.getTime() >= start.getTime() && e.at.getTime() < end.getTime()),
    ).sort(compareWeekEvents);
    let cells: HealthCell[];
    if (input.health) {
      const cellStarts: Date[] = [];
      for (let h = 0; h < 24; h++) cellStarts.push(zonedTimeToUtc(tz, p.year, p.month, p.day, h));
      cells = dayHealth(cellStarts, end, now, input.health, samplingStart);
    } else {
      cells = Array.from({ length: 24 }, (): HealthCell => "none");
    }
    days.push({
      date,
      label: WEEKDAY_LABELS[i]!,
      isToday: date === today,
      isPast: end.getTime() <= now.getTime(),
      events: here.slice(0, WEEK_EVENTS_PER_DAY).map((e) => ({
        kind: e.kind,
        title: e.title,
        detail: e.detail,
        at: e.at.toISOString(),
        tone: e.tone,
        href: e.href,
      })),
      moreCount: Math.max(0, here.length - WEEK_EVENTS_PER_DAY),
      health: cells,
    });
  }
  const first = zonedParts(weekStart, tz);
  return { weekStart: `${first.year}-${pad(first.month)}-${pad(first.day)}`, today, days };
}
