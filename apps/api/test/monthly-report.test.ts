import { describe, expect, it } from "vitest";
import { isReportMonth, monthBounds, monthTitle, previousMonth, reportMedian, reportSummaryLines, uptimePercent, type MonthlyReport } from "@church/shared";

const H = 3_600_000;

describe("monthly report rules", () => {
  it("months on the site's calendar", () => {
    expect(previousMonth(new Date("2026-11-01T07:00:00Z"), "Europe/London")).toBe("2026-10");
    expect(previousMonth(new Date("2026-01-01T09:00:00Z"), "UTC")).toBe("2025-12");
    // 23:30 UTC on 31 Oct is already 1 Nov in Auckland.
    expect(previousMonth(new Date("2026-10-31T23:30:00Z"), "Pacific/Auckland")).toBe("2026-10");
    const b = monthBounds("2026-10", "Europe/London");
    expect(b.start.toISOString()).toBe("2026-09-30T23:00:00.000Z"); // BST midnight
    expect(b.end.toISOString()).toBe("2026-11-01T00:00:00.000Z"); // GMT midnight
    expect(isReportMonth("2026-13")).toBe(false);
    expect(monthTitle("2026-10")).toBe("October 2026");
  });
  it("uptime counts overlapping incidents once and clips to the month", () => {
    const from = 0;
    const to = 100 * H;
    expect(uptimePercent([], from, to, to)).toBe(100);
    expect(uptimePercent([{ startedAt: 10 * H, resolvedAt: 20 * H }], from, to, to)).toBe(90);
    expect(uptimePercent([{ startedAt: 10 * H, resolvedAt: 20 * H }, { startedAt: 15 * H, resolvedAt: 25 * H }], from, to, to)).toBe(85);
    expect(uptimePercent([{ startedAt: -10 * H, resolvedAt: 5 * H }], from, to, to)).toBe(95);
    expect(uptimePercent([{ startedAt: 90 * H, resolvedAt: null }], from, to, to)).toBe(90);
  });
  it("median and the summary lines", () => {
    expect(reportMedian([])).toBeNull();
    expect(reportMedian([5, 1, 3])).toBe(3);
    expect(reportMedian([1, 2, 3, 4])).toBe(2.5);
    const r: MonthlyReport = {
      month: "2026-10",
      generatedAt: "",
      services: [{ name: "Internet", uptime: 99.5, incidents: 1, longestMinutes: 200 }, { name: "Stream", uptime: 100, incidents: 0, longestMinutes: 0 }],
      incidents: { total: 1, acknowledged: 1 },
      tickets: { opened: 12, resolved: 10, medianResolutionHours: 6.5, responseBreaches: 1, resolutionBreaches: 0, openAtEnd: 3 },
      backups: { succeeded: 31, failed: 0, lastVerifiedAt: null },
      renewalsNextMonth: [{ name: "CCLI", renewsOn: "2026-11-15" }],
    };
    expect(reportSummaryLines(r)).toEqual([
      "Services: average uptime 99.75% across 2; lowest Internet at 99.5%.",
      "Incidents: 1 (1 acknowledged).",
      "Helpdesk: 12 opened, 10 resolved, median 6.5 h to resolve; 1 SLA breach; 3 still open.",
      "Backups: 31 made.",
      "Renewing next month: CCLI (2026-11-15).",
    ]);
  });
});
