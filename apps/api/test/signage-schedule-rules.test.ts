import { describe, expect, it } from "vitest";
import {
  createSignageScheduleSchema,
  describeSignageRepeat,
  legacySignagePriority,
  normaliseSignageSchedule,
  signageScheduleConflicts,
  signageScheduleProblem,
  signageTargetsShare,
  type ConflictEntry,
} from "@lampstand/shared";

/** docs/signage.md section 9: one schedule for one-time and repeating entries, five priorities, conflicts refused at save. */

const TZ = "America/Chicago";
const S1 = "00000000-0000-4000-8000-000000000001";
const S2 = "00000000-0000-4000-8000-000000000002";
const G = "00000000-0000-4000-8000-00000000000a";
const NOW = new Date("2026-11-11T12:00:00Z"); // Wednesday
const members = new Map([[G, [S1]]]);

function weekly(id: string, over: Partial<ConflictEntry> = {}): ConflictEntry {
  return { id, name: id, kind: "weekly", targetType: "screen", targetId: S1, priority: 3, startsAt: null, endsAt: null, daysOfWeek: [7], monthWeeks: null, startTime: "08:00", endTime: "12:00", startDate: null, endDate: null, enabled: true, ...over };
}
function once(id: string, start: string, end: string, over: Partial<ConflictEntry> = {}): ConflictEntry {
  return weekly(id, { kind: "once", startsAt: new Date(start), endsAt: new Date(end), daysOfWeek: [], startTime: null, endTime: null, ...over });
}

describe("schedule entry checks", () => {
  it("needs both instants for a one-time entry and times and days for a repeating one", () => {
    const base = { name: "x", targetType: "screen", targetId: S1, playlistId: S2 };
    expect(createSignageScheduleSchema.safeParse({ ...base, kind: "once" }).success).toBe(false);
    expect(createSignageScheduleSchema.safeParse({ ...base, kind: "once", startsAt: "2026-11-15T14:00:00Z", endsAt: "2026-11-15T13:00:00Z" }).success).toBe(false);
    const ok = createSignageScheduleSchema.parse({ ...base, kind: "once", startsAt: "2026-11-15T14:00:00Z", endsAt: "2026-11-15T16:00:00Z" });
    expect(ok.priority).toBe(3);
    expect(createSignageScheduleSchema.safeParse({ ...base, kind: "weekly", startTime: "08:00", endTime: "09:00" }).success).toBe(false);
    expect(createSignageScheduleSchema.safeParse({ ...base, kind: "monthly", startTime: "08:00", endTime: "09:00", daysOfWeek: [6] }).success).toBe(false);
    const m = createSignageScheduleSchema.parse({ ...base, kind: "monthly", startTime: "08:00", endTime: "09:00", daysOfWeek: [6], monthWeeks: [-1, 1, 1] });
    expect(m.monthWeeks).toEqual([1, -1]);
    expect(createSignageScheduleSchema.safeParse({ ...base, kind: "weekly", startTime: "08:00", endTime: "09:00", daysOfWeek: [7], priority: 6 }).success).toBe(false);
    expect(createSignageScheduleSchema.safeParse({ ...base, targetType: "all", kind: "weekly", startTime: "08:00", endTime: "09:00", daysOfWeek: [7] }).success).toBe(false);
  });

  it("clears the fields a kind does not use", () => {
    const n = normaliseSignageSchedule({ ...weekly("a"), kind: "once", startsAt: "2026-11-15T14:00:00Z", endsAt: "2026-11-15T16:00:00Z" } as never) as unknown as ConflictEntry;
    expect(n).toMatchObject({ daysOfWeek: [], startTime: null, endTime: null, monthWeeks: null });
    expect(signageScheduleProblem({ ...weekly("b"), startsAt: null, endsAt: null } as never)).toBeNull();
  });

  it("maps old priorities: events Highest, schedules around the old default", () => {
    expect(legacySignagePriority(1000, true)).toBe(5);
    expect(legacySignagePriority(50, false)).toBe(2);
    expect(legacySignagePriority(100, false)).toBe(3);
    expect(legacySignagePriority(500, false)).toBe(4);
  });

  it("describes repeats in words", () => {
    expect(describeSignageRepeat(weekly("a", { daysOfWeek: [7] }))).toBe("Every Sunday, 08:00-12:00");
    expect(describeSignageRepeat(weekly("a", { daysOfWeek: [1, 2, 3, 4, 5] }))).toBe("Weekdays, 08:00-12:00");
    expect(describeSignageRepeat(weekly("a", { kind: "monthly", daysOfWeek: [6], monthWeeks: [1, -1] }))).toBe("The first and last Saturday of the month, 08:00-12:00");
  });
});

describe("schedule conflicts", () => {
  it("targets share a screen through a group or all screens", () => {
    expect(signageTargetsShare({ targetType: "screen", targetId: S1 }, { targetType: "group", targetId: G }, members)).toBe(true);
    expect(signageTargetsShare({ targetType: "screen", targetId: S2 }, { targetType: "group", targetId: G }, members)).toBe(false);
    expect(signageTargetsShare({ targetType: "screen", targetId: S2 }, { targetType: "all", targetId: null }, members)).toBe(true);
  });

  it("refuses the same priority at the same time on a common screen, and names the other entry", () => {
    const sunday = weekly("sunday");
    const c = signageScheduleConflicts(once("wedding", "2026-11-15T15:00:00Z", "2026-11-15T20:00:00Z", { priority: 3 }), [sunday], members, TZ, NOW);
    expect(c).toHaveLength(1);
    expect(c[0]!.name).toBe("sunday");
    expect(c[0]!.at.toISOString()).toBe("2026-11-15T15:00:00.000Z");
    // A different priority, another screen, another time, or an entry switched off: no conflict.
    expect(signageScheduleConflicts(once("w", "2026-11-15T15:00:00Z", "2026-11-15T20:00:00Z", { priority: 4 }), [sunday], members, TZ, NOW)).toEqual([]);
    expect(signageScheduleConflicts(once("w", "2026-11-15T15:00:00Z", "2026-11-15T20:00:00Z", { targetId: S2 }), [sunday], members, TZ, NOW)).toEqual([]);
    expect(signageScheduleConflicts(once("w", "2026-11-15T19:00:00Z", "2026-11-15T20:00:00Z"), [sunday], members, TZ, NOW)).toEqual([]);
    expect(signageScheduleConflicts(once("w", "2026-11-15T15:00:00Z", "2026-11-15T20:00:00Z"), [weekly("off", { enabled: false })], members, TZ, NOW)).toEqual([]);
  });

  it("ignores what is over, and editing an entry never conflicts with itself", () => {
    const past = once("past", "2026-11-01T15:00:00Z", "2026-11-01T20:00:00Z");
    expect(signageScheduleConflicts(weekly("sunday"), [past], members, TZ, NOW)).toEqual([]);
    expect(signageScheduleConflicts(weekly("same"), [weekly("same")], members, TZ, NOW)).toEqual([]);
  });

  it("finds monthly and weekly rules that meet only some weeks, through a group", () => {
    const lastSat = weekly("last-sat", { kind: "monthly", daysOfWeek: [6], monthWeeks: [-1], targetType: "group", targetId: G });
    const fourthSat = weekly("fourth-sat", { kind: "monthly", daysOfWeek: [6], monthWeeks: [4] });
    // The fourth Saturday is the last one in a month with four Saturdays (November 2026 has 7, 14, 21, 28).
    const c = signageScheduleConflicts(fourthSat, [lastSat], members, TZ, NOW);
    expect(c[0]?.at.toISOString()).toBe("2026-11-28T14:00:00.000Z");
    const firstSat = weekly("first-sat", { kind: "monthly", daysOfWeek: [6], monthWeeks: [1] });
    expect(signageScheduleConflicts(firstSat, [lastSat], members, TZ, NOW)).toEqual([]);
    // Date ranges that do not meet do not conflict.
    const before = weekly("before", { endDate: "2026-12-01" });
    expect(signageScheduleConflicts(weekly("after", { startDate: "2026-12-02" }), [before], members, TZ, NOW)).toEqual([]);
  });
});
