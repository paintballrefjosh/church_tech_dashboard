import { ForbiddenException, Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, isNotNull, isNull, lt, or, sql, max } from "drizzle-orm";
import {
  PERMISSIONS,
  REPORT_KEYS,
  monthBounds,
  monthTitle,
  previousMonth,
  reportMedian,
  reportSummaryLines,
  uptimePercent,
  zonedParts,
  type MonthlyReport,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { DB, type Db } from "../db/db.module";
import { backups, groupMemberships, groups, monitorIncidents, monitors, renewals, tickets } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { JobStateService } from "../cluster/job-state.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { SettingsService } from "../settings/settings.service";

/** The report goes out on the 1st, from this hour on the site's clock. */
const SEND_HOUR = 8;

/**
 * The monthly report (packages/shared/src/monthly-report.ts): figures gathered here, words there. The hourly
 * `monthly-report` job sends last month's on the 1st once (`job_state` remembers the month sent; one leader runs it).
 */
@Injectable()
export class ReportsService implements OnModuleInit {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly jobState: JobStateService,
    private readonly notifications: NotificationsService,
    private readonly delivery: NotificationDeliveryService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "monthly-report", everyMs: 60 * 60_000, initialDelayMs: 4 * 60_000, run: async () => void (await this.sendIfDue()) });
  }

  /** The configured group's name, or "admin". */
  private async groupName(): Promise<string> {
    const g = await this.settings.get(REPORT_KEYS.group);
    return typeof g === "string" && g.trim() ? g.trim() : "admin";
  }

  /** Site admins and members of the report's group may read it (elders need no other access). */
  async assertCanRead(user: AuthenticatedUser): Promise<void> {
    if (user.permissions.includes(PERMISSIONS.SITE_ADMIN)) return;
    if (user.groups.includes(await this.groupName())) return;
    throw new ForbiddenException("The monthly report is for site admins and the group it is sent to.");
  }

  async build(month: string, now: Date = new Date()): Promise<MonthlyReport> {
    const tz = await this.delivery.zone();
    const { start, end } = monthBounds(month, tz);
    const from = start.getTime();
    const to = Math.min(end.getTime(), now.getTime());
    const overlapping = and(lt(monitorIncidents.startedAt, end), or(isNull(monitorIncidents.resolvedAt), gte(monitorIncidents.resolvedAt, start)));

    const [mons, incs, monthIncidents, ticketRows, breaches, backupRows, verified, renewing] = await Promise.all([
      this.db.select({ id: monitors.id, name: monitors.name, statusName: monitors.statusName }).from(monitors).where(eq(monitors.enabled, true)),
      this.db
        .select({ monitorId: monitorIncidents.monitorId, startedAt: monitorIncidents.startedAt, resolvedAt: monitorIncidents.resolvedAt })
        .from(monitorIncidents)
        .where(and(isNotNull(monitorIncidents.monitorId), overlapping)),
      this.db
        .select({ ack: monitorIncidents.acknowledgedAt })
        .from(monitorIncidents)
        .where(and(gte(monitorIncidents.startedAt, start), lt(monitorIncidents.startedAt, end))),
      this.db
        .select({ createdAt: tickets.createdAt, resolvedAt: tickets.resolvedAt, closedAt: tickets.closedAt })
        .from(tickets)
        .where(lt(tickets.createdAt, end)),
      this.db
        .select({
          response: sql<string | number>`count(*) FILTER (WHERE ${tickets.responseBreachedAt} >= ${start} AND ${tickets.responseBreachedAt} < ${end})`,
          resolution: sql<string | number>`count(*) FILTER (WHERE ${tickets.resolutionBreachedAt} >= ${start} AND ${tickets.resolutionBreachedAt} < ${end})`,
        })
        .from(tickets),
      this.db
        .select({ status: backups.status })
        .from(backups)
        .where(and(gte(backups.createdAt, start), lt(backups.createdAt, end))),
      this.db.select({ at: max(backups.verifiedAt) }).from(backups),
      this.db.select({ name: renewals.name, renewsOn: renewals.renewsOn }).from(renewals).orderBy(renewals.renewsOn),
    ]);

    const byMonitor = new Map<string, Array<{ startedAt: number; resolvedAt: number | null }>>();
    for (const i of incs) {
      const list = byMonitor.get(i.monitorId!) ?? [];
      list.push({ startedAt: i.startedAt.getTime(), resolvedAt: i.resolvedAt?.getTime() ?? null });
      byMonitor.set(i.monitorId!, list);
    }
    const services = mons
      .map((m) => {
        const list = byMonitor.get(m.id) ?? [];
        const longest = list.reduce((mx, i) => Math.max(mx, Math.min(to, i.resolvedAt ?? to) - Math.max(from, i.startedAt)), 0);
        return { name: m.statusName?.trim() || m.name, uptime: uptimePercent(list, from, to, now.getTime()), incidents: list.length, longestMinutes: Math.round(longest / 60_000) };
      })
      .sort((a, b) => a.uptime - b.uptime || a.name.localeCompare(b.name));

    const inMonth = (d: Date | null) => d !== null && d >= start && d < end;
    const resolvedInMonth = ticketRows.filter((t) => inMonth(t.resolvedAt ?? t.closedAt));
    const done = (t: (typeof ticketRows)[number]) => t.resolvedAt ?? t.closedAt;
    const median = reportMedian(resolvedInMonth.map((t) => (done(t)!.getTime() - t.createdAt.getTime()) / 3_600_000));

    const p = zonedParts(end, tz);
    const nextMonth = `${p.year}-${String(p.month).padStart(2, "0")}`;
    return {
      month,
      generatedAt: now.toISOString(),
      services,
      incidents: { total: monthIncidents.length, acknowledged: monthIncidents.filter((i) => i.ack !== null).length },
      tickets: {
        opened: ticketRows.filter((t) => inMonth(t.createdAt)).length,
        resolved: resolvedInMonth.length,
        medianResolutionHours: median === null ? null : Math.round(median * 10) / 10,
        responseBreaches: Number(breaches[0]?.response ?? 0),
        resolutionBreaches: Number(breaches[0]?.resolution ?? 0),
        openAtEnd: ticketRows.filter((t) => {
          const d = done(t);
          return d === null || d >= end;
        }).length,
      },
      backups: {
        succeeded: backupRows.filter((b) => b.status === "ready").length,
        failed: backupRows.filter((b) => b.status === "failed").length,
        lastVerifiedAt: verified[0]?.at ? new Date(verified[0].at).toISOString() : null,
      },
      renewalsNextMonth: renewing.filter((r) => r.renewsOn.startsWith(`${nextMonth}-`)),
    };
  }

  /** On the 1st from SEND_HOUR, once per month: last month's report to the group. */
  async sendIfDue(now: Date = new Date()): Promise<{ sent: string | null }> {
    if ((await this.settings.get(REPORT_KEYS.enabled)) !== true) return { sent: null };
    const tz = await this.delivery.zone();
    const p = zonedParts(now, tz);
    if (p.day !== 1 || p.hour < SEND_HOUR) return { sent: null };
    const month = previousMonth(now, tz);
    const last = await this.jobState.get<string>("monthly-report", "last-sent");
    if (last?.value === month) return { sent: null };
    // Remember first: a crash after this loses one report rather than sending it twice.
    await this.jobState.set("monthly-report", "last-sent", month);
    const report = await this.build(month, now);
    const name = await this.groupName();
    const members = await this.db
      .select({ id: groupMemberships.userId })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(eq(groups.name, name));
    await this.notifications.createMany(
      members.map((m) => ({
        recipientUserId: m.id,
        kind: "report.monthly",
        title: `Monthly report: ${monthTitle(month)}`,
        body: reportSummaryLines(report).join("\n"),
        link: `/reports/monthly?month=${month}`,
      })),
    );
    this.logger.log(`monthly report for ${month} sent to ${members.length} member(s) of "${name}"`);
    return { sent: month };
  }
}
