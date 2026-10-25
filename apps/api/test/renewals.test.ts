import { describe, expect, it } from "vitest";
import { createRenewalSchema, daysUntil, renewalNoticeTitle, renewalReminderDue, renewalState, siteToday } from "@church/shared";

const r = (renewsOn: string, remindDays = [30, 7]) => ({ renewsOn, remindDays });

describe("renewal dates", () => {
  it("counts whole calendar days, across a DST change", () => {
    expect(daysUntil("2026-11-01", "2026-10-25")).toBe(7);
    expect(daysUntil("2026-10-24", "2026-10-25")).toBe(-1);
    expect(daysUntil("2027-03-29", "2027-03-27")).toBe(2);
  });
  it("today is the site's date, not the server's", () => {
    // 23:30 UTC on the 25th is already the 26th in Auckland.
    expect(siteToday(new Date("2026-10-25T23:30:00Z"), "Pacific/Auckland")).toBe("2026-10-26");
    expect(siteToday(new Date("2026-10-25T23:30:00Z"), "Europe/London")).toBe("2026-10-25");
  });
  it("draws overdue, today, soon and later", () => {
    expect(renewalState(r("2026-10-20"), "2026-10-25")).toBe("overdue");
    expect(renewalState(r("2026-10-25"), "2026-10-25")).toBe("today");
    expect(renewalState(r("2026-11-20"), "2026-10-25")).toBe("soon");
    expect(renewalState(r("2027-01-20"), "2026-10-25")).toBe("later");
  });
});

describe("renewalReminderDue", () => {
  it("sends each reminder once, nearest first, and the lapse once", () => {
    const x = r("2026-12-01");
    expect(renewalReminderDue(x, null, "2026-10-01")).toBeNull(); // 61 days out
    expect(renewalReminderDue(x, null, "2026-11-01")).toBe("2026-12-01:30");
    expect(renewalReminderDue(x, "2026-12-01:30", "2026-11-10")).toBeNull();
    expect(renewalReminderDue(x, "2026-12-01:30", "2026-11-24")).toBe("2026-12-01:7");
    expect(renewalReminderDue(x, "2026-12-01:7", "2026-11-30")).toBeNull();
    expect(renewalReminderDue(x, "2026-12-01:7", "2026-12-02")).toBe("2026-12-01:overdue");
    expect(renewalReminderDue(x, "2026-12-01:overdue", "2026-12-05")).toBeNull();
  });
  it("one notice, not two, for a renewal added inside both windows", () => {
    expect(renewalReminderDue(r("2026-10-30"), null, "2026-10-25")).toBe("2026-10-30:7");
  });
  it("never goes back to an earlier reminder of the same date", () => {
    expect(renewalReminderDue(r("2026-10-30", [30, 7, 60]), "2026-10-30:7", "2026-10-25")).toBeNull();
  });
  it("a new date starts the reminders again; long lapsed is history, not news", () => {
    expect(renewalReminderDue(r("2027-10-30"), "2026-10-30:overdue", "2027-10-01")).toBe("2027-10-30:30");
    expect(renewalReminderDue(r("2026-01-01"), null, "2026-10-25")).toBeNull();
  });
  it("says it in plain words", () => {
    expect(renewalNoticeTitle("CCLI streaming", "2026-10-26", "2026-10-25")).toBe("CCLI streaming renews in 1 day (2026-10-26)");
    expect(renewalNoticeTitle("Domain", "2026-10-20", "2026-10-25")).toBe("Domain lapsed on 2026-10-20");
  });
});

describe("createRenewalSchema", () => {
  it("needs a real date; reminders are bounded", () => {
    expect(createRenewalSchema.safeParse({ name: "x", renewsOn: "2026-02-30" }).success).toBe(false);
    expect(createRenewalSchema.safeParse({ name: "x", renewsOn: "2028-02-29" }).success).toBe(true);
    expect(createRenewalSchema.safeParse({ name: "x", renewsOn: "next year" }).success).toBe(false);
    expect(createRenewalSchema.safeParse({ name: "x", renewsOn: "2026-12-01", remindDays: [400] }).success).toBe(false);
    expect(createRenewalSchema.parse({ name: "x", renewsOn: "2026-12-01" }).remindDays).toEqual([30, 7]);
  });
});
