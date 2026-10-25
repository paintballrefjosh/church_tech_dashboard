import { zonedParts, zonedTimeToUtc } from "./dashboard/zoned";

/**
 * The monthly report: one calendar month (on the site's clock) of uptime, incidents, the helpdesk, backups and what renews
 * next. The API gathers the figures (`ReportsService`); everything here is pure, unit-tested in
 * apps/api/test/monthly-report.test.ts. Sent on the 1st to the group in `reports.monthly_group` (blank = admin group) when
 * `reports.monthly_enabled` is on, and readable for any month at /reports/monthly.
 */

export const REPORT_KEYS = { enabled: "reports.monthly_enabled", group: "reports.monthly_group" } as const;

/** "2026-10". */
export function isReportMonth(s: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** The month before the one `now` is in, on the site's clock. */
export function previousMonth(now: Date, tz: string): string {
  const p = zonedParts(now, tz);
  const y = p.month === 1 ? p.year - 1 : p.year;
  const m = p.month === 1 ? 12 : p.month - 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Start (inclusive) and end (exclusive) of a month as instants, from midnight on the 1st on the site's clock. */
export function monthBounds(month: string, tz: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return { start: zonedTimeToUtc(tz, y, m, 1), end: zonedTimeToUtc(tz, next.y, next.m, 1) };
}

/**
 * Percent of the window [from, to) not covered by the incidents (each [startedAt, resolvedAt or `now`)). Overlapping
 * incidents are not counted twice. Rounded to two places.
 */
export function uptimePercent(incidents: ReadonlyArray<{ startedAt: number; resolvedAt: number | null }>, from: number, to: number, now: number): number {
  const spans = incidents
    .map((i) => [Math.max(from, i.startedAt), Math.min(to, i.resolvedAt ?? now)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let down = 0;
  let cursor = from;
  for (const [a, b] of spans) {
    const s = Math.max(a, cursor);
    if (b > s) {
      down += b - s;
      cursor = b;
    }
  }
  const total = to - from;
  if (total <= 0) return 100;
  return Math.round((1 - down / total) * 10_000) / 100;
}

export interface MonthlyReport {
  month: string;
  generatedAt: string;
  services: Array<{ name: string; uptime: number; incidents: number; longestMinutes: number }>;
  incidents: { total: number; acknowledged: number };
  tickets: { opened: number; resolved: number; medianResolutionHours: number | null; responseBreaches: number; resolutionBreaches: number; openAtEnd: number };
  backups: { succeeded: number; failed: number; lastVerifiedAt: string | null };
  renewalsNextMonth: Array<{ name: string; renewsOn: string }>;
}

export function reportMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** "October 2026". */
export function monthTitle(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[m - 1]} ${y}`;
}

/** The report as a few plain lines, for the notification and the email. The page shows the full tables. */
export function reportSummaryLines(r: MonthlyReport): string[] {
  const lines: string[] = [];
  if (r.services.length) {
    const worst = [...r.services].sort((a, b) => a.uptime - b.uptime)[0]!;
    const avg = Math.round((r.services.reduce((s, x) => s + x.uptime, 0) / r.services.length) * 100) / 100;
    lines.push(`Services: average uptime ${avg}% across ${r.services.length}; lowest ${worst.name} at ${worst.uptime}%.`);
  }
  lines.push(`Incidents: ${r.incidents.total} (${r.incidents.acknowledged} acknowledged).`);
  const t = r.tickets;
  lines.push(
    `Helpdesk: ${t.opened} opened, ${t.resolved} resolved${t.medianResolutionHours !== null ? `, median ${t.medianResolutionHours} h to resolve` : ""}; ` +
      `${t.responseBreaches + t.resolutionBreaches} SLA breach${t.responseBreaches + t.resolutionBreaches === 1 ? "" : "es"}; ${t.openAtEnd} still open.`,
  );
  lines.push(`Backups: ${r.backups.succeeded} made${r.backups.failed ? `, ${r.backups.failed} failed` : ""}.`);
  if (r.renewalsNextMonth.length) {
    lines.push(`Renewing next month: ${r.renewalsNextMonth.map((x) => `${x.name} (${x.renewsOn})`).join(", ")}.`);
  }
  return lines;
}
