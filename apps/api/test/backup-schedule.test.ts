import { describe, expect, it } from "vitest";
import { nextRunAfter, zonedToUtc } from "../src/backup/schedule";

const iso = (d: Date) => d.toISOString();

describe("backup schedule: next run", () => {
  it("daily in UTC: later today if the time has not passed, else tomorrow", () => {
    const spec = { frequency: "daily", time: "03:00", dayOfWeek: 0, dayOfMonth: 1, timezone: "UTC" } as const;
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T01:00:00Z")))).toBe("2026-10-05T03:00:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T03:00:00Z")))).toBe("2026-10-06T03:00:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T23:59:00Z")))).toBe("2026-10-06T03:00:00.000Z");
  });

  it("follows the zone's daylight saving: 02:30 in London is 01:30 UTC in summer and 02:30 UTC in winter", () => {
    const spec = { frequency: "daily", time: "02:30", dayOfWeek: 0, dayOfMonth: 1, timezone: "Europe/London" } as const;
    expect(iso(nextRunAfter(spec, new Date("2026-07-01T00:00:00Z")))).toBe("2026-07-01T01:30:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-12-01T00:00:00Z")))).toBe("2026-12-01T02:30:00.000Z");
  });

  it("stays at the same local time across the clocks changing", () => {
    // Clocks go back in London on 2026-10-25.
    const spec = { frequency: "daily", time: "09:00", dayOfWeek: 0, dayOfMonth: 1, timezone: "Europe/London" } as const;
    expect(iso(nextRunAfter(spec, new Date("2026-10-24T12:00:00Z")))).toBe("2026-10-25T09:00:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-10-25T12:00:00Z")))).toBe("2026-10-26T09:00:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-10-24T05:00:00Z")))).toBe("2026-10-24T08:00:00.000Z");
  });

  it("works for zones behind UTC and for a time that is the previous day in UTC", () => {
    const spec = { frequency: "daily", time: "23:00", dayOfWeek: 0, dayOfMonth: 1, timezone: "America/New_York" } as const;
    // 23:00 EDT (UTC-4) on 5 Oct = 03:00 UTC on 6 Oct.
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T12:00:00Z")))).toBe("2026-10-06T03:00:00.000Z");
  });

  it("weekly: the named weekday, never today's past slot", () => {
    // 2026-10-05 is a Monday. dayOfWeek 0 = Sunday.
    const spec = { frequency: "weekly", time: "04:00", dayOfWeek: 0, dayOfMonth: 1, timezone: "UTC" } as const;
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T10:00:00Z")))).toBe("2026-10-11T04:00:00.000Z");
    const monday = { ...spec, dayOfWeek: 1 };
    expect(iso(nextRunAfter(monday, new Date("2026-10-05T05:00:00Z")))).toBe("2026-10-12T04:00:00.000Z");
    expect(iso(nextRunAfter(monday, new Date("2026-10-05T03:00:00Z")))).toBe("2026-10-05T04:00:00.000Z");
  });

  it("monthly: the named day, rolling into the next month and over a year end", () => {
    const spec = { frequency: "monthly", time: "00:15", dayOfWeek: 0, dayOfMonth: 15, timezone: "UTC" } as const;
    expect(iso(nextRunAfter(spec, new Date("2026-10-05T00:00:00Z")))).toBe("2026-10-15T00:15:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-10-15T00:15:00Z")))).toBe("2026-11-15T00:15:00.000Z");
    expect(iso(nextRunAfter(spec, new Date("2026-12-20T00:00:00Z")))).toBe("2027-01-15T00:15:00.000Z");
  });

  it("handles a time that does not exist (clocks going forward) by running just after the gap", () => {
    // Clocks go forward in London at 01:00 on 2026-03-29: 01:30 does not exist that day.
    const at = zonedToUtc("Europe/London", 2026, 3, 29, 1, 30);
    expect(at.getTime()).toBeGreaterThanOrEqual(new Date("2026-03-29T00:30:00Z").getTime());
    expect(at.getTime()).toBeLessThanOrEqual(new Date("2026-03-29T01:30:00Z").getTime());
  });

  it("zonedToUtc maps a local wall time to the right instant", () => {
    expect(iso(zonedToUtc("Europe/London", 2026, 7, 1, 12, 0))).toBe("2026-07-01T11:00:00.000Z");
    expect(iso(zonedToUtc("Europe/London", 2026, 1, 1, 12, 0))).toBe("2026-01-01T12:00:00.000Z");
    expect(iso(zonedToUtc("Asia/Kolkata", 2026, 1, 1, 12, 0))).toBe("2026-01-01T06:30:00.000Z");
  });
});
