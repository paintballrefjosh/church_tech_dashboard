import {
  calendarDaysBetween,
  formatTimeInZone,
  zonedParts,
  type HomeSnapshot,
  type NeedItem,
  type NextService,
  type SystemsHealth,
} from "@church/shared";

type Team = NonNullable<NextService["team"]>;

const WEEKDAY_SHORT: Record<number, string> = { 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun" };

function longDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(
    date,
  );
}

/** "Saturday, 10 October" in the zone. */
export function dateLine(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long" })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.weekday ?? ""}, ${parts.day ?? ""} ${parts.month ?? ""}`;
}

export function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The service-kind start times, in order, as dates. Falls back to the service's own start. */
export function serviceStarts(svc: NextService): Date[] {
  const times = svc.times
    .filter((t) => t.kind === "service" && t.startsAt)
    .map((t) => new Date(t.startsAt as string))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  if (times.length > 0) return times;
  if (svc.startsAt) {
    const d = new Date(svc.startsAt);
    if (!Number.isNaN(d.getTime())) return [d];
  }
  return [];
}

/** The first service start that has not passed yet (or the last one). */
export function countdownTarget(starts: readonly Date[], now: Date): Date | null {
  if (starts.length === 0) return null;
  return starts.find((d) => d.getTime() >= now.getTime()) ?? starts[starts.length - 1] ?? null;
}

/** "Tomorrow, 9:00 and 10:45", "Today, 9:00 am", "Sunday 18 October, 9:00 and 10:45". */
export function whenLine(starts: readonly Date[], now: Date, tz: string): string | null {
  const first = starts[0];
  if (!first) return null;
  const days = calendarDaysBetween(now, first, tz);
  let day: string;
  if (days === 0) day = "Today";
  else if (days === 1) day = "Tomorrow";
  else day = longDay(first, tz).replace(/^(\p{L}+),? /u, "$1 ");
  const times = starts.map((d) => formatTimeInZone(d, tz));
  const meridiems = new Set(times.map((t) => t.slice(-2)));
  const shown = times.length > 1 && meridiems.size === 1 ? times.map((t) => t.replace(/ ?[ap]m$/, "")) : times;
  return `${day}, ${joinAnd(shown)}`;
}

/** Positions with nobody confirmed or waiting (empty, or everyone declined). */
export function unfilledPositions(team: Team): string[] {
  return team.positions
    .filter((p) => !p.people.some((x) => x.status !== "declined"))
    .map((p) => p.name);
}

export function teamHeadline(team: Team): string {
  const missing = unfilledPositions(team);
  if (missing.length === 1) return `${missing[0]} still needs filling.`;
  if (missing.length === 2) return `${joinAnd(missing)} still need filling.`;
  if (missing.length > 2) return `${missing.length} positions still need filling.`;
  if (team.waiting > 0) {
    return team.waiting === 1 ? "One person has not replied yet." : `${team.waiting} people have not replied yet.`;
  }
  return "Everyone is confirmed.";
}

/** The "58 of 59 up" half of the Systems header. */
export function systemsCount(s: SystemsHealth): string {
  if (s.totals.total === 0) return "Nothing is being monitored yet.";
  return `${s.totals.up} of ${s.totals.total} up.`;
}

/** The problem in plain words, or null when nothing is down. */
export function systemsProblem(s: SystemsHealth): string | null {
  const names = s.problems.map((p) => p.name);
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is down.`;
  if (names.length === 2) return `${joinAnd(names)} are down.`;
  return `${names.length} systems are down.`;
}

const NEED_SOURCE_LABEL: Record<NeedItem["source"], [string, string]> = {
  ticket: ["ticket", "tickets"],
  system: ["system problem", "system problems"],
  team: ["team item", "team items"],
  checklist: ["checklist", "checklists"],
};

export function needsHeadline(items: readonly NeedItem[]): string {
  if (items.length === 0) return "Nothing is waiting on you.";
  const counts = new Map<NeedItem["source"], number>();
  for (const i of items) counts.set(i.source, (counts.get(i.source) ?? 0) + 1);
  const parts = [...counts.entries()].map(([src, n]) => `${n} ${NEED_SOURCE_LABEL[src][n === 1 ? 0 : 1]}`);
  return joinAnd(parts);
}

export const NEED_KIND: Record<NeedItem["source"], string> = {
  ticket: "Ticket",
  system: "System",
  team: "Team",
  checklist: "Checklist",
};

/** "6:02 pm" for today, "Thu" within the week, "3 Oct" otherwise, all on the zone's calendar. */
export function whenShort(at: string, now: Date, tz: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const days = calendarDaysBetween(d, now, tz);
  if (days <= 0) return formatTimeInZone(d, tz);
  if (days < 7) return WEEKDAY_SHORT[zonedParts(d, tz).weekday] ?? "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short" }).format(d);
}

export function greeting(snapshot: Pick<HomeSnapshot, "dayPart" | "user">): string {
  return `Good ${snapshot.dayPart}, ${snapshot.user.firstName}`;
}
