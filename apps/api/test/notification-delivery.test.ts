import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  emailReleaseAt,
  formatClock,
  inQuietHours,
  isUrgentNotificationKind,
  nextClockTime,
  notificationDeliverySchema,
  parseClock,
  pushAllowed,
  type NotificationDelivery,
} from "@church/shared";

const LON = "Europe/London";
const d = (over: Partial<NotificationDelivery> = {}): NotificationDelivery => ({ ...DEFAULT_NOTIFICATION_DELIVERY, ...over });
const at = (iso: string) => new Date(iso);
const iso = (x: Date) => x.toISOString();

describe("clock helpers", () => {
  it("formats and parses a time of day", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(22 * 60 + 5)).toBe("22:05");
    expect(parseClock("07:30")).toBe(450);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("7:30")).toBeNull();
    expect(parseClock("")).toBeNull();
  });
});

describe("notificationDeliverySchema", () => {
  it("accepts the defaults", () => {
    expect(notificationDeliverySchema.safeParse(DEFAULT_NOTIFICATION_DELIVERY).success).toBe(true);
  });
  it("refuses quiet hours that start and end together, but only when they are on", () => {
    expect(notificationDeliverySchema.safeParse(d({ quietEnabled: true, quietStart: 60, quietEnd: 60 })).success).toBe(false);
    expect(notificationDeliverySchema.safeParse(d({ quietEnabled: false, quietStart: 60, quietEnd: 60 })).success).toBe(true);
  });
  it("refuses a time outside the day", () => {
    expect(notificationDeliverySchema.safeParse(d({ digestAt: 1440 })).success).toBe(false);
    expect(notificationDeliverySchema.safeParse(d({ digestAt: -1 })).success).toBe(false);
  });
});

describe("inQuietHours", () => {
  const q = d({ quietEnabled: true, quietStart: 22 * 60, quietEnd: 7 * 60 });
  it("is never true when off", () => {
    expect(inQuietHours(d(), at("2026-01-15T23:00:00Z"), LON)).toBe(false);
  });
  it("covers a window that crosses midnight, on the site's clock", () => {
    expect(inQuietHours(q, at("2026-01-15T22:00:00Z"), LON)).toBe(true);
    expect(inQuietHours(q, at("2026-01-16T06:59:00Z"), LON)).toBe(true);
    expect(inQuietHours(q, at("2026-01-16T07:00:00Z"), LON)).toBe(false);
    expect(inQuietHours(q, at("2026-01-15T12:00:00Z"), LON)).toBe(false);
  });
  it("uses the zone, not UTC (BST is an hour ahead)", () => {
    // 21:30 UTC in July is 22:30 in London.
    expect(inQuietHours(q, at("2026-07-15T21:30:00Z"), LON)).toBe(true);
    expect(inQuietHours(q, at("2026-07-15T21:30:00Z"), "UTC")).toBe(false);
  });
  it("covers a same-day window", () => {
    const lunch = d({ quietEnabled: true, quietStart: 12 * 60, quietEnd: 13 * 60 });
    expect(inQuietHours(lunch, at("2026-01-15T12:30:00Z"), LON)).toBe(true);
    expect(inQuietHours(lunch, at("2026-01-15T13:00:00Z"), LON)).toBe(false);
  });
});

describe("nextClockTime", () => {
  it("is today when the time is still ahead, tomorrow when it has passed", () => {
    expect(iso(nextClockTime(8 * 60, at("2026-01-15T07:00:00Z"), LON))).toBe("2026-01-15T08:00:00.000Z");
    expect(iso(nextClockTime(8 * 60, at("2026-01-15T08:00:01Z"), LON))).toBe("2026-01-16T08:00:00.000Z");
  });
  it("counts an exact match as now", () => {
    expect(iso(nextClockTime(8 * 60, at("2026-01-15T08:00:00Z"), LON))).toBe("2026-01-15T08:00:00.000Z");
  });
  it("follows daylight saving", () => {
    // 08:00 London on 2026-07-15 is 07:00 UTC.
    expect(iso(nextClockTime(8 * 60, at("2026-07-15T00:00:00Z"), LON))).toBe("2026-07-15T07:00:00.000Z");
  });
});

describe("pushAllowed", () => {
  const q = d({ quietEnabled: true });
  const night = at("2026-01-15T23:30:00Z");
  it("is allowed whenever quiet hours are off", () => {
    expect(pushAllowed("ticket.comment", d(), night, LON)).toBe(true);
  });
  it("holds ordinary kinds back during quiet hours", () => {
    expect(pushAllowed("ticket.comment", q, night, LON)).toBe(false);
  });
  it("lets an urgent kind through, unless the person turned that off", () => {
    expect(pushAllowed("monitor.incident.opened", q, night, LON)).toBe(true);
    expect(pushAllowed("monitor.incident.opened", d({ quietEnabled: true, urgentThrough: false }), night, LON)).toBe(false);
  });
  it("allows everything outside the window", () => {
    expect(pushAllowed("ticket.comment", q, at("2026-01-15T12:00:00Z"), LON)).toBe(true);
  });
});

describe("emailReleaseAt", () => {
  const created = at("2026-01-15T14:00:00Z");
  it("is immediate with the defaults", () => {
    expect(emailReleaseAt("ticket.comment", created, d(), LON)).toEqual(created);
  });
  it("holds a night-time email until quiet hours end", () => {
    const q = d({ quietEnabled: true });
    expect(iso(emailReleaseAt("ticket.comment", at("2026-01-15T23:15:00Z"), q, LON))).toBe("2026-01-16T07:00:00.000Z");
    // After midnight, the same morning.
    expect(iso(emailReleaseAt("ticket.comment", at("2026-01-16T03:00:00Z"), q, LON))).toBe("2026-01-16T07:00:00.000Z");
  });
  it("sends at once outside quiet hours", () => {
    const q = d({ quietEnabled: true });
    expect(emailReleaseAt("ticket.comment", created, q, LON)).toEqual(created);
  });
  it("holds everything until the daily summary time", () => {
    const s = d({ digestEnabled: true, digestAt: 8 * 60 });
    expect(iso(emailReleaseAt("ticket.comment", at("2026-01-15T14:00:00Z"), s, LON))).toBe("2026-01-16T08:00:00.000Z");
    expect(iso(emailReleaseAt("ticket.comment", at("2026-01-15T06:30:00Z"), s, LON))).toBe("2026-01-15T08:00:00.000Z");
  });
  it("puts a summary time that falls in quiet hours off until they end", () => {
    const s = d({ digestEnabled: true, digestAt: 6 * 60, quietEnabled: true });
    expect(iso(emailReleaseAt("ticket.comment", at("2026-01-15T14:00:00Z"), s, LON))).toBe("2026-01-16T07:00:00.000Z");
  });
  it("lets an urgent kind past both, unless the person turned that off", () => {
    const s = d({ digestEnabled: true, quietEnabled: true });
    const night = at("2026-01-15T23:30:00Z");
    expect(emailReleaseAt("monitor.incident.opened", night, s, LON)).toEqual(night);
    const strict = d({ digestEnabled: true, quietEnabled: true, urgentThrough: false });
    expect(emailReleaseAt("monitor.incident.opened", night, strict, LON).getTime()).toBeGreaterThan(night.getTime());
  });
  it("is the same instant for everything held over one night, so it goes out as one email", () => {
    const q = d({ quietEnabled: true });
    const a = emailReleaseAt("ticket.comment", at("2026-01-15T22:10:00Z"), q, LON);
    const b = emailReleaseAt("wiki.updated", at("2026-01-16T05:55:00Z"), q, LON);
    expect(a.getTime()).toBe(b.getTime());
  });
});

describe("urgent kinds", () => {
  it("are the down alerts only", () => {
    expect(isUrgentNotificationKind("monitor.incident.opened")).toBe(true);
    expect(isUrgentNotificationKind("monitor.incident.resolved")).toBe(false);
    expect(isUrgentNotificationKind("ticket.sla_breached")).toBe(false);
  });
});
