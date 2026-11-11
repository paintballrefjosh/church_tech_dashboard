import { zonedParts } from "../dashboard/zoned";
import { scheduleWindows, type CompileSchedule, type Interval } from "./compile";
import type { SignageTargetType } from "./schemas";

/**
 * Schedule conflicts (docs/signage.md section 9). Two entries conflict when they would be on at the same moment, on at least
 * one common screen, with the same priority: which one shows would then depend on details nobody sees, so saving refuses it
 * and the person picks a different priority for one of them.
 */

export type ConflictEntry = Pick<
  CompileSchedule,
  "id" | "name" | "kind" | "targetType" | "targetId" | "priority" | "startsAt" | "endsAt" | "daysOfWeek" | "monthWeeks" | "startTime" | "endTime" | "startDate" | "endDate" | "enabled"
>;

/** How far ahead repeating entries are compared: two years holds every combination of weekday and week of the month. */
export const SIGNAGE_CONFLICT_HORIZON_DAYS = 731;

/** Do two targets reach at least one common screen? "All screens" reaches every screen; a group, its members. */
export function signageTargetsShare(
  a: { targetType: SignageTargetType; targetId: string | null },
  b: { targetType: SignageTargetType; targetId: string | null },
  groupMembers: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (a.targetType === "all" || b.targetType === "all") return true;
  if (a.targetType === b.targetType && a.targetId === b.targetId) return true;
  const screensOf = (t: { targetType: SignageTargetType; targetId: string | null }) => (t.targetType === "screen" ? [t.targetId ?? ""] : (groupMembers.get(t.targetId ?? "") ?? []));
  const sa = new Set(screensOf(a));
  return screensOf(b).some((id) => sa.has(id));
}

/** The first moment two lists of windows overlap, or null. */
function firstOverlap(a: Interval[], b: Interval[]): number | null {
  const x = [...a].sort((p, q) => p.start - q.start);
  const y = [...b].sort((p, q) => p.start - q.start);
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const s = Math.max(x[i]!.start, y[j]!.start);
    const e = Math.min(x[i]!.end, y[j]!.end);
    if (s < e) return s;
    if (x[i]!.end <= y[j]!.end) i++;
    else j++;
  }
  return null;
}

function dayStart(date: string | null): number {
  return date ? Date.parse(`${date}T00:00:00Z`) - 86_400_000 : -Infinity;
}

/** When `a` and `b` are first both on from `now` on (ignoring targets and priority), or null. */
export function signageScheduleOverlap(a: ConflictEntry, b: ConflictEntry, tz: string, now: Date): Date | null {
  let from = now.getTime();
  let to: number;
  const once = [a, b].filter((s) => s.kind === "once");
  if (once.length) {
    for (const s of once) {
      if (!s.startsAt || !s.endsAt) return null;
      from = Math.max(from, s.startsAt.getTime());
    }
    to = Math.min(...once.map((s) => s.endsAt!.getTime()));
  } else {
    from = Math.max(from, dayStart(a.startDate), dayStart(b.startDate));
    to = from + SIGNAGE_CONFLICT_HORIZON_DAYS * 86_400_000;
  }
  if (to <= from) return null;
  const at = firstOverlap(scheduleWindows(a, new Date(from), new Date(to), tz), scheduleWindows(b, new Date(from), new Date(to), tz));
  return at === null ? null : new Date(Math.max(at, from));
}

export interface SignageScheduleConflict {
  id: string;
  name: string;
  /** The first moment both are on. */
  at: Date;
}

/** Every entry `candidate` conflicts with (same priority, a common screen, on at the same moment from now on). */
export function signageScheduleConflicts(candidate: ConflictEntry, others: ConflictEntry[], groupMembers: ReadonlyMap<string, readonly string[]>, tz: string, now: Date): SignageScheduleConflict[] {
  if (!candidate.enabled) return [];
  const out: SignageScheduleConflict[] = [];
  for (const o of others) {
    if (o.id === candidate.id || !o.enabled || o.priority !== candidate.priority) continue;
    if (!signageTargetsShare(candidate, o, groupMembers)) continue;
    const at = signageScheduleOverlap(candidate, o, tz, now);
    if (at) out.push({ id: o.id, name: o.name, at });
  }
  return out.sort((p, q) => p.at.getTime() - q.at.getTime());
}

/** "Sun 15 Nov 2026 08:00" on the site's clock, for messages. */
export function signageMomentText(at: Date, tz: string): string {
  const p = zonedParts(at, tz);
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[p.weekday - 1]} ${p.day} ${months[p.month - 1]} ${p.year} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const ORDINALS: Record<number, string> = { 1: "first", 2: "second", 3: "third", 4: "fourth", [-1]: "last" };
const DAY_WORDS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function listWords(words: string[]): string {
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** A repeating entry in words: "Every Sunday, 08:00-13:00", "The first and last Saturday of the month, 18:00-21:00". */
export function describeSignageRepeat(s: Pick<ConflictEntry, "kind" | "daysOfWeek" | "monthWeeks" | "startTime" | "endTime">): string {
  const times = `${s.startTime ?? "?"}-${s.endTime ?? "?"}`;
  const days = [...s.daysOfWeek].sort((a, b) => a - b);
  if (s.kind === "monthly") {
    const weeks = (s.monthWeeks ?? []).map((w) => ORDINALS[w] ?? String(w));
    return `The ${listWords(weeks)} ${listWords(days.map((d) => DAY_WORDS[d - 1]!))} of the month, ${times}`;
  }
  if (days.length === 7) return `Every day, ${times}`;
  if (days.join() === "1,2,3,4,5") return `Weekdays, ${times}`;
  if (days.join() === "6,7") return `Weekends, ${times}`;
  return `Every ${listWords(days.map((d) => DAY_WORDS[d - 1]!))}, ${times}`;
}

/**
 * The 1-5 level for a row saved before schedules and events were merged (migration 0093): schedules used 0-999 (default 100)
 * and events 0-100000 above every schedule, so events become Highest and schedules Low / Normal / High around the old default.
 */
export function legacySignagePriority(priority: number, wasEvent: boolean): number {
  if (wasEvent) return 5;
  if (priority < 100) return 2;
  if (priority === 100) return 3;
  return 4;
}
