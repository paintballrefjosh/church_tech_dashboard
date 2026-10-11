import { describe, expect, it } from "vitest";
import { buildWeek, type HealthRow, type WeekEventInput } from "@church/shared";

const ev = (over: Partial<WeekEventInput> & { at: Date }): WeekEventInput => ({
  kind: "ticket",
  title: "t",
  detail: null,
  tone: "info",
  href: null,
  ...over,
});

const none = { rows: [] as HealthRow[], incidents: [] };

describe("buildWeek", () => {
  it("builds Monday to Sunday around now in London", () => {
    // Thursday 8 Oct 2026, 13:00 BST.
    const w = buildWeek({ now: new Date("2026-10-08T12:00:00Z"), timezone: "Europe/London", events: [], health: none });
    expect(w.weekStart).toBe("2026-10-05");
    expect(w.today).toBe("2026-10-08");
    expect(w.days.map((d) => d.label)).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(w.days.map((d) => d.isToday)).toEqual([false, false, false, true, false, false, false]);
    expect(w.days.map((d) => d.isPast)).toEqual([true, true, true, false, false, false, false]);
    for (const d of w.days) expect(d.health).toHaveLength(24);
  });

  it("handles the autumn DST week in London (a 25 hour Sunday)", () => {
    // Clocks go back Sunday 25 Oct 2026.
    const w = buildWeek({ now: new Date("2026-10-27T12:00:00Z"), timezone: "Europe/London", events: [], health: none });
    expect(w.weekStart).toBe("2026-10-26");
    const prev = buildWeek({ now: new Date("2026-10-24T12:00:00Z"), timezone: "Europe/London", events: [], health: none });
    expect(prev.days.map((d) => d.date)).toEqual([
      "2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25",
    ]);
    // 00:30 BST on the Sunday is still the Sunday, and so is 23:30 GMT.
    const sun = buildWeek({
      now: new Date("2026-10-24T12:00:00Z"),
      timezone: "Europe/London",
      events: [
        ev({ title: "early", at: new Date("2026-10-24T23:30:00Z") }),
        ev({ title: "late", at: new Date("2026-10-25T23:30:00Z") }),
        ev({ title: "monday", at: new Date("2026-10-26T00:00:00Z") }),
      ],
      health: none,
    });
    expect(sun.days[6]!.events.map((e) => e.title)).toEqual(["early", "late"]);
  });

  it("handles the spring DST week in America/Chicago", () => {
    // Clocks go forward Sunday 8 Mar 2026 at 02:00.
    const w = buildWeek({
      now: new Date("2026-03-08T20:00:00Z"),
      timezone: "America/Chicago",
      events: [ev({ title: "sun", at: new Date("2026-03-08T15:00:00Z") }), ev({ title: "mon", at: new Date("2026-03-09T05:00:00Z") })],
      health: none,
    });
    expect(w.weekStart).toBe("2026-03-02");
    expect(w.today).toBe("2026-03-08");
    expect(w.days[6]!.events.map((e) => e.title)).toEqual(["sun"]);
    // 05:00Z on Monday is midnight CDT: the first instant of the next week, not the Sunday.
    expect(w.days[6]!.events).toHaveLength(1);
  });

  it("puts an event at exactly midnight on the new day", () => {
    const w = buildWeek({
      now: new Date("2026-10-08T12:00:00Z"),
      timezone: "Europe/London",
      // 00:00 BST Wednesday = 23:00Z Tuesday.
      events: [ev({ title: "midnight", at: new Date("2026-10-06T23:00:00Z") })],
      health: none,
    });
    expect(w.days[1]!.events).toHaveLength(0);
    expect(w.days[2]!.events.map((e) => e.title)).toEqual(["midnight"]);
  });

  it("leaves empty days empty", () => {
    const w = buildWeek({ now: new Date("2026-10-08T12:00:00Z"), timezone: "Europe/London", events: [], health: none });
    for (const d of w.days) {
      expect(d.events).toEqual([]);
      expect(d.moreCount).toBe(0);
    }
  });

  it("keeps the three most important events and counts the rest", () => {
    const day = new Date("2026-10-07T10:00:00Z");
    const at = (m: number) => new Date(day.getTime() + m * 60_000);
    const w = buildWeek({
      now: new Date("2026-10-08T12:00:00Z"),
      timezone: "Europe/London",
      events: [
        ev({ title: "wiki", kind: "wiki", at: at(0) }),
        ev({ title: "ticket", kind: "ticket", at: at(1) }),
        ev({ title: "warn incident", kind: "incident", tone: "warn", at: at(2) }),
        ev({ title: "bad incident", kind: "incident", tone: "bad", at: at(3) }),
        ev({ title: "backup", kind: "backup", tone: "ok", at: at(4) }),
      ],
      health: none,
    });
    const d = w.days[2]!;
    expect(d.events.map((e) => e.title)).toEqual(["bad incident", "warn incident", "ticket"]);
    expect(d.moreCount).toBe(2);
  });

  describe("health", () => {
    const now = new Date("2026-10-08T12:00:00Z"); // 13:00 BST Thursday
    const hour = (iso: string) => iso;

    it("marks the future, and none without monitoring access", () => {
      const w = buildWeek({ now, timezone: "Europe/London", events: [], health: null });
      expect(w.days[0]!.health.every((c) => c === "none")).toBe(true);
      expect(w.days.every((d) => d.health.every((c) => c === "none"))).toBe(true);
    });

    it("marks hours after now as future", () => {
      const w = buildWeek({ now, timezone: "Europe/London", events: [], health: none });
      expect(w.days[3]!.health.slice(14).every((c) => c === "future")).toBe(true);
      expect(w.days[3]!.health[13]).toBe("none");
      expect(w.days[4]!.health.every((c) => c === "future")).toBe(true);
    });

    it("classifies hours from samples", () => {
      // Wednesday 7 Oct, local hours 09 (down), 10 (partial), 11 (up); sampling began at 09:00 BST.
      const rows: HealthRow[] = [
        { kind: "monitor", ref: "a", hour: hour("2026-10-07T08:00:00Z"), samples: 60, down: 30 },
        { kind: "monitor", ref: "b", hour: hour("2026-10-07T08:00:00Z"), samples: 60, down: 0 },
        { kind: "monitor", ref: "a", hour: hour("2026-10-07T09:00:00Z"), samples: 60, down: 5 },
        { kind: "monitor", ref: "a", hour: hour("2026-10-07T10:00:00Z"), samples: 60, down: 0 },
      ];
      const w = buildWeek({ now, timezone: "Europe/London", events: [], health: { rows, incidents: [] } });
      const wed = w.days[2]!.health;
      expect(wed[9]).toBe("down");
      expect(wed[10]).toBe("partial");
      expect(wed[11]).toBe("up");
      // After sampling began, an hour with no samples is "none".
      expect(wed[12]).toBe("none");
      // Before sampling began with no incident: none.
      expect(wed[3]).toBe("none");
    });

    it("falls back to incident overlap before sampling began", () => {
      const rows: HealthRow[] = [{ kind: "monitor", ref: "a", hour: "2026-10-07T08:00:00Z", samples: 60, down: 0 }];
      const incidents = [
        // Tuesday 14:10 to 14:40 BST.
        { start: new Date("2026-10-06T13:10:00Z"), end: new Date("2026-10-06T13:40:00Z") },
        // Monday 20:00 BST to 00:30 Tuesday.
        { start: new Date("2026-10-05T19:00:00Z"), end: new Date("2026-10-05T23:30:00Z") },
        // Thursday 12:30 BST, still open.
        { start: new Date("2026-10-08T11:30:00Z"), end: null },
      ];
      const w = buildWeek({ now, timezone: "Europe/London", events: [], health: { rows, incidents } });
      expect(w.days[1]!.health[14]).toBe("down");
      expect(w.days[1]!.health[13]).toBe("none");
      expect(w.days[0]!.health[20]).toBe("down");
      expect(w.days[0]!.health[23]).toBe("down");
      expect(w.days[0]!.health[19]).toBe("none");
      // After sampling began, an incident does not override a missing sample.
      expect(w.days[3]!.health[12]).toBe("none");
    });

    it("has 24 cells on a 25 hour day and folds the repeated hour", () => {
      // 25 Oct 2026 London: 01:00 happens twice (00:00Z and 01:00Z).
      const rows: HealthRow[] = [
        { kind: "monitor", ref: "a", hour: "2026-10-25T00:00:00Z", samples: 60, down: 0 },
        { kind: "monitor", ref: "a", hour: "2026-10-25T01:00:00Z", samples: 60, down: 60 },
      ];
      const w = buildWeek({
        now: new Date("2026-10-25T20:00:00Z"),
        timezone: "Europe/London",
        events: [],
        health: { rows, incidents: [] },
      });
      const sun = w.days[6]!.health;
      expect(sun).toHaveLength(24);
      // 01:00 cell spans both occurrences: 60 of 120 samples down is at least half.
      expect(sun[1]).toBe("down");
    });
  });
});
