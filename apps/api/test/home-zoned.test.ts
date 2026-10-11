import { describe, expect, it } from "vitest";
import {
  addDaysInZone,
  calendarDaysBetween,
  formatTimeInZone,
  hourStartsInZone,
  startOfDayInZone,
  startOfWeekInZone,
  zonedParts,
  zonedTimeToUtc,
} from "@church/shared";

const LON = "Europe/London";
const CHI = "America/Chicago";
const iso = (d: Date) => d.toISOString();

describe("zonedParts", () => {
  it("reads the wall clock and ISO weekday", () => {
    expect(zonedParts(new Date("2026-10-11T00:30:00Z"), LON)).toEqual({
      year: 2026,
      month: 10,
      day: 11,
      hour: 1,
      minute: 30,
      second: 0,
      weekday: 7,
    });
    expect(zonedParts(new Date("2026-10-12T04:59:00Z"), CHI)).toMatchObject({ day: 11, hour: 23, weekday: 7 });
  });
  it("never reports hour 24", () => {
    expect(zonedParts(new Date("2026-01-01T00:00:00Z"), LON).hour).toBe(0);
  });
});

describe("startOfDayInZone", () => {
  it("is local midnight, not UTC midnight", () => {
    expect(iso(startOfDayInZone(new Date("2026-10-08T12:00:00Z"), LON))).toBe("2026-10-07T23:00:00.000Z");
    expect(iso(startOfDayInZone(new Date("2026-10-08T12:00:00Z"), "UTC"))).toBe("2026-10-08T00:00:00.000Z");
  });
  it("handles the London spring change (23 hour day)", () => {
    const start = startOfDayInZone(new Date("2026-03-29T12:00:00Z"), LON);
    expect(iso(start)).toBe("2026-03-29T00:00:00.000Z");
    const next = startOfDayInZone(new Date("2026-03-30T12:00:00Z"), LON);
    expect(iso(next)).toBe("2026-03-29T23:00:00.000Z");
    expect(next.getTime() - start.getTime()).toBe(23 * 3_600_000);
  });
  it("handles the London autumn change (25 hour day)", () => {
    const start = startOfDayInZone(new Date("2026-10-25T12:00:00Z"), LON);
    expect(iso(start)).toBe("2026-10-24T23:00:00.000Z");
    const next = startOfDayInZone(new Date("2026-10-26T12:00:00Z"), LON);
    expect(iso(next)).toBe("2026-10-26T00:00:00.000Z");
    expect(next.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });
  it("handles the Chicago spring change", () => {
    expect(iso(startOfDayInZone(new Date("2026-03-08T18:00:00Z"), CHI))).toBe("2026-03-08T06:00:00.000Z");
    expect(iso(startOfDayInZone(new Date("2026-03-09T18:00:00Z"), CHI))).toBe("2026-03-09T05:00:00.000Z");
  });
  it("handles the Chicago autumn change", () => {
    expect(iso(startOfDayInZone(new Date("2026-11-01T18:00:00Z"), CHI))).toBe("2026-11-01T05:00:00.000Z");
    expect(iso(startOfDayInZone(new Date("2026-11-02T18:00:00Z"), CHI))).toBe("2026-11-02T06:00:00.000Z");
  });
  it("is stable for an instant just after midnight", () => {
    expect(iso(startOfDayInZone(new Date("2026-10-07T23:00:00Z"), LON))).toBe("2026-10-07T23:00:00.000Z");
    expect(iso(startOfDayInZone(new Date("2026-10-07T22:59:59Z"), LON))).toBe("2026-10-06T23:00:00.000Z");
  });
});

describe("startOfWeekInZone", () => {
  it("is the Monday at local midnight", () => {
    // Sunday 11 Oct 2026 belongs to the week of Monday 5 Oct.
    expect(iso(startOfWeekInZone(new Date("2026-10-11T12:00:00Z"), LON))).toBe("2026-10-04T23:00:00.000Z");
    // A Monday is its own week start.
    expect(iso(startOfWeekInZone(new Date("2026-10-05T08:00:00Z"), LON))).toBe("2026-10-04T23:00:00.000Z");
  });
  it("spans the London changes", () => {
    // Week of 23 March ends the day clocks go forward; the next week starts an hour earlier in UTC.
    expect(iso(startOfWeekInZone(new Date("2026-03-29T12:00:00Z"), LON))).toBe("2026-03-23T00:00:00.000Z");
    expect(iso(startOfWeekInZone(new Date("2026-03-31T12:00:00Z"), LON))).toBe("2026-03-29T23:00:00.000Z");
    // Autumn: the week of 26 Oct starts on GMT, the day before it on BST.
    expect(iso(startOfWeekInZone(new Date("2026-10-28T12:00:00Z"), LON))).toBe("2026-10-26T00:00:00.000Z");
    expect(iso(startOfWeekInZone(new Date("2026-10-25T12:00:00Z"), LON))).toBe("2026-10-18T23:00:00.000Z");
  });
  it("spans the Chicago changes", () => {
    expect(iso(startOfWeekInZone(new Date("2026-03-08T12:00:00Z"), CHI))).toBe("2026-03-02T06:00:00.000Z");
    expect(iso(startOfWeekInZone(new Date("2026-03-10T12:00:00Z"), CHI))).toBe("2026-03-09T05:00:00.000Z");
    expect(iso(startOfWeekInZone(new Date("2026-11-01T18:00:00Z"), CHI))).toBe("2026-10-26T05:00:00.000Z");
    expect(iso(startOfWeekInZone(new Date("2026-11-03T18:00:00Z"), CHI))).toBe("2026-11-02T06:00:00.000Z");
  });
});

describe("addDaysInZone", () => {
  it("keeps the wall-clock time across a change", () => {
    // 10:00 on Saturday 28 March (GMT) plus a day is 10:00 on the 29th (BST): 23 hours later.
    const a = new Date("2026-03-28T10:00:00Z");
    const b = addDaysInZone(a, LON, 1);
    expect(iso(b)).toBe("2026-03-29T09:00:00.000Z");
    expect(b.getTime() - a.getTime()).toBe(23 * 3_600_000);
    // Chicago autumn: a day is 25 hours.
    const c = new Date("2026-10-31T15:00:00Z");
    expect(addDaysInZone(c, CHI, 1).getTime() - c.getTime()).toBe(25 * 3_600_000);
  });
  it("goes back and across month ends", () => {
    expect(iso(addDaysInZone(new Date("2026-03-01T12:00:00Z"), LON, -1))).toBe("2026-02-28T12:00:00.000Z");
    expect(iso(addDaysInZone(new Date("2026-01-31T12:00:00Z"), LON, 1))).toBe("2026-02-01T12:00:00.000Z");
    expect(iso(addDaysInZone(new Date("2026-12-31T12:00:00Z"), LON, 1))).toBe("2027-01-01T12:00:00.000Z");
  });
});

describe("zonedTimeToUtc", () => {
  it("lands just after the spring gap for a time that does not exist", () => {
    // 01:30 on 29 March 2026 does not exist in London; the clock jumps 01:00 to 02:00.
    expect(iso(zonedTimeToUtc(LON, 2026, 3, 29, 1, 30))).toBe("2026-03-29T01:30:00.000Z");
    expect(zonedParts(zonedTimeToUtc(LON, 2026, 3, 29, 1, 30), LON).hour).toBe(2);
  });
  it("takes the first of a repeated autumn time", () => {
    // 01:30 on 25 Oct 2026 happens twice; the first is still on BST (00:30Z).
    expect(iso(zonedTimeToUtc(LON, 2026, 10, 25, 1, 30))).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("hourStartsInZone", () => {
  it("returns real consecutive hours from the start of the current hour", () => {
    const hours = hourStartsInZone(new Date("2026-03-29T00:30:00Z"), LON, 4).map(iso);
    expect(hours).toEqual([
      "2026-03-29T00:00:00.000Z",
      "2026-03-29T01:00:00.000Z",
      "2026-03-29T02:00:00.000Z",
      "2026-03-29T03:00:00.000Z",
    ]);
    // Across the change the wall clock skips an hour: 00:00 GMT, then 02:00 BST.
    expect(hours.map((h) => zonedParts(new Date(h), LON).hour)).toEqual([0, 2, 3, 4]);
  });
  it("repeats an hour of the wall clock in autumn", () => {
    const hours = hourStartsInZone(new Date("2026-10-24T23:10:00Z"), LON, 4);
    expect(hours.map((h) => zonedParts(h, LON).hour)).toEqual([0, 1, 1, 2]);
  });
  it("respects half-hour zones", () => {
    const [first] = hourStartsInZone(new Date("2026-10-10T10:10:00Z"), "Asia/Kolkata", 1);
    expect(iso(first!)).toBe("2026-10-10T09:30:00.000Z");
  });
  it("returns nothing for a count of zero", () => {
    expect(hourStartsInZone(new Date(), LON, 0)).toEqual([]);
  });
});

describe("formatting and day counts", () => {
  it("formats the clock in the zone", () => {
    expect(formatTimeInZone(new Date("2026-10-08T20:40:00Z"), LON)).toBe("9:40 pm");
    expect(formatTimeInZone(new Date("2026-10-08T20:40:00Z"), CHI)).toBe("3:40 pm");
    expect(formatTimeInZone(new Date("2026-01-08T09:05:00Z"), LON)).toBe("9:05 am");
  });
  it("counts calendar days, not 24 hour blocks", () => {
    expect(calendarDaysBetween(new Date("2026-10-08T08:00:00Z"), new Date("2026-10-08T22:00:00Z"), LON)).toBe(0);
    expect(calendarDaysBetween(new Date("2026-10-08T12:00:00Z"), new Date("2026-10-11T09:00:00Z"), LON)).toBe(3);
    // 23:30 on the 24th London (BST) is 22:30Z; 00:30 on the 25th is 23:30Z: next calendar day.
    expect(calendarDaysBetween(new Date("2026-10-24T22:30:00Z"), new Date("2026-10-24T23:30:00Z"), LON)).toBe(1);
  });
});
