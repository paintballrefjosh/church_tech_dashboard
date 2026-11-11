import { describe, expect, it } from "vitest";
import type { SignageSchedule } from "@lampstand/shared";
import { addDays, byDay, dayTitle, entryMatches, monthGrid, occurrences, siteInstant, timeOnDay } from "./schedule-model";

const TZ = "America/Chicago";
const S1 = "00000000-0000-4000-8000-000000000001";
const G = "00000000-0000-4000-8000-00000000000a";

function entry(over: Partial<SignageSchedule>): SignageSchedule {
  return {
    id: "e",
    name: "Sunday",
    kind: "weekly",
    targetType: "screen",
    targetId: S1,
    targetName: "Foyer",
    playlistId: "p",
    playlistName: "P",
    priority: 3,
    startsAt: null,
    endsAt: null,
    daysOfWeek: [7],
    monthWeeks: null,
    startTime: "08:00",
    endTime: "12:00",
    startDate: null,
    endDate: null,
    forcePowerOn: false,
    enabled: true,
    state: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("schedule month model", () => {
  it("lays a month out in whole weeks, Sunday first", () => {
    const g = monthGrid("2026-11");
    // 1 Nov 2026 is a Sunday; 30 Nov a Monday, so the grid ends Saturday 5 Dec.
    expect(g[0]).toBe("2026-11-01");
    expect(g[g.length - 1]).toBe("2026-12-05");
    expect(g).toHaveLength(35);
    expect(monthGrid("2027-02")[0]).toBe("2027-01-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(dayTitle("2026-11-15")).toBe("Sunday 15 November");
  });

  it("puts repeating entries on their days and a one-time entry on every day it covers", () => {
    const weekly = entry({});
    const monthly = entry({ id: "m", kind: "monthly", daysOfWeek: [6], monthWeeks: [-1], startTime: "18:00", endTime: "21:00" });
    const conference = entry({ id: "c", kind: "once", startsAt: siteInstant("2026-11-20", "17:00", TZ), endsAt: siteInstant("2026-11-22", "14:00", TZ), daysOfWeek: [], startTime: null, endTime: null });
    const off = entry({ id: "off", enabled: false });
    const days = byDay(occurrences([weekly, monthly, conference, off], "2026-11-01", "2026-12-05", TZ));
    expect([...days.keys()].filter((d) => days.get(d)!.some((o) => o.entry.id === "e"))).toEqual(["2026-11-01", "2026-11-08", "2026-11-15", "2026-11-22", "2026-11-29"]);
    expect([...days.keys()].filter((d) => days.get(d)!.some((o) => o.entry.id === "m"))).toEqual(["2026-11-28"]);
    const conf = (d: string) => days.get(d)!.find((o) => o.entry.id === "c")!;
    expect(timeOnDay(conf("2026-11-20"), "2026-11-20")).toBe("from 17:00");
    expect(timeOnDay(conf("2026-11-21"), "2026-11-21")).toBe("all day");
    expect(timeOnDay(conf("2026-11-22"), "2026-11-22")).toBe("until 14:00");
    expect(timeOnDay(days.get("2026-11-08")![0]!, "2026-11-08")).toBe("08:00-12:00");
    // A switched-off entry stays on the calendar (drawn greyed by the page), flagged by its own `enabled`.
    const offDays = [...days.values()].flat().filter((o) => o.entry.id === "off");
    expect(offDays.length).toBeGreaterThan(0);
    expect(offDays.every((o) => o.entry.enabled === false)).toBe(true);
  });

  it("filters by screen (its own, its groups', all screens) or by group", () => {
    const screens = [{ id: S1, groupIds: [G] }] as never;
    expect(entryMatches(entry({ targetType: "group", targetId: G }), `screen:${S1}`, screens)).toBe(true);
    expect(entryMatches(entry({ targetType: "all", targetId: null }), `group:${G}`, screens)).toBe(true);
    expect(entryMatches(entry({ targetType: "screen", targetId: S1 }), `group:${G}`, screens)).toBe(false);
  });
});
