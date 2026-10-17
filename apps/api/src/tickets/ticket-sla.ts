import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  SLA_WARN_PERCENT_KEY,
  TICKET_PRIORITIES,
  describeSlaMinutes,
  slaAlertsDue,
  slaWarnPercent,
  type SlaAlert,
  type TicketPriority,
  type TicketSlaMap,
  type TicketStatus,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { groupMemberships, groupModuleAccess, groups, tickets, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";

/** Tickets older than this are not looked at: whatever they owed has long been sent or silently flagged. */
const SCAN_DAYS = 30;

export interface SlaRunResult {
  warnings: number;
  breaches: number;
  /** Flagged without a notice because they were noticed too late to be news. */
  silent: number;
}

/**
 * Tells the assignee (or, when nobody has the ticket, the support team) when a ticket has used most of a response or
 * resolution target and when it has missed one. Each notice is sent once: it is CLAIMED by one conditional UPDATE on the
 * ticket's `*_at` column before anything is sent, so two nodes never send the same one (a crash between the claim and the
 * send loses that one notice, which is the right way round for something that repeats nothing). A ticket waiting on the
 * requester has no running clock (`slaAlertsDue`), and changing its priority starts the notices over.
 */
@Injectable()
export class TicketSla implements OnModuleInit {
  private readonly logger = new Logger(TicketSla.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "ticket-sla", everyMs: 60_000, initialDelayMs: 50_000, run: async () => void (await this.run()) });
  }

  async slaMap(): Promise<TicketSlaMap> {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
    const entries = await Promise.all(
      TICKET_PRIORITIES.map(async (p) => {
        const [response, resolution] = await Promise.all([
          this.settings.get(`tickets.sla.response_min.${p}`).catch(() => 0),
          this.settings.get(`tickets.sla.resolution_min.${p}`).catch(() => 0),
        ]);
        return [p, { responseMin: num(response), resolutionMin: num(resolution) }] as const;
      }),
    );
    return Object.fromEntries(entries) as TicketSlaMap;
  }

  async run(now: Date = new Date()): Promise<SlaRunResult> {
    const result: SlaRunResult = { warnings: 0, breaches: 0, silent: 0 };
    const map = await this.slaMap();
    if (TICKET_PRIORITIES.every((p) => map[p].responseMin === 0 && map[p].resolutionMin === 0)) return result;
    const warnPercent = slaWarnPercent(await this.settings.get(SLA_WARN_PERCENT_KEY).catch(() => undefined));

    const rows = await this.db
      .select()
      .from(tickets)
      .where(and(inArray(tickets.status, ["open", "in_progress"]), gte(tickets.createdAt, new Date(now.getTime() - SCAN_DAYS * 86_400_000))));

    let staff: string[] | null = null;
    for (const t of rows) {
      const alerts = slaAlertsDue(
        {
          priority: t.priority as TicketPriority,
          status: t.status as TicketStatus,
          createdAt: t.createdAt.toISOString(),
          firstResponseAt: t.firstResponseAt ? t.firstResponseAt.toISOString() : null,
          waitingSince: t.waitingSince ? t.waitingSince.toISOString() : null,
          waitedMs: t.waitedMs,
        },
        map,
        warnPercent,
        {
          responseWarned: t.responseWarnedAt !== null,
          responseBreached: t.responseBreachedAt !== null,
          resolutionWarned: t.resolutionWarnedAt !== null,
          resolutionBreached: t.resolutionBreachedAt !== null,
        },
        now,
      );
      for (const alert of alerts) {
        if (!(await this.claim(t, alert, now))) continue;
        if (alert.stale) {
          result.silent++;
          continue;
        }
        const recipients = t.assignedUserId ? [t.assignedUserId] : (staff ??= await this.staffIds());
        const what = alert.clock === "response" ? "first-response" : "resolution";
        const title =
          alert.level === "warn"
            ? `Ticket #${t.number} is nearing its ${what} target`
            : `Ticket #${t.number} has missed its ${what} target`;
        const body = `${t.title.slice(0, 160)} (${t.priority} priority, target ${describeSlaMinutes(alert.targetMin)})`;
        await this.notifications.createMany(
          recipients.map((id) => ({
            recipientUserId: id,
            kind: alert.level === "warn" ? "ticket.sla_warning" : "ticket.sla_breached",
            title,
            body,
            link: `/tickets/${t.id}`,
          })),
        );
        if (alert.level === "warn") result.warnings++;
        else result.breaches++;
      }
    }
    if (result.warnings + result.breaches > 0) {
      this.logger.log(`ticket SLA: ${result.warnings} warning(s), ${result.breaches} breach(es)`);
    }
    return result;
  }

  /** Take one notice for a ticket; true for the one caller that got it. A breach also settles the warning it overtook. */
  private async claim(t: typeof tickets.$inferSelect, alert: SlaAlert, now: Date): Promise<boolean> {
    const response = alert.clock === "response";
    const set =
      alert.level === "warn"
        ? response
          ? { responseWarnedAt: now }
          : { resolutionWarnedAt: now }
        : response
          ? { responseBreachedAt: now, responseWarnedAt: t.responseWarnedAt ?? now }
          : { resolutionBreachedAt: now, resolutionWarnedAt: t.resolutionWarnedAt ?? now };
    const unclaimed =
      alert.level === "warn"
        ? response
          ? isNull(tickets.responseWarnedAt)
          : isNull(tickets.resolutionWarnedAt)
        : response
          ? isNull(tickets.responseBreachedAt)
          : isNull(tickets.resolutionBreachedAt);
    const claimed = await this.db
      .update(tickets)
      .set(set)
      .where(and(eq(tickets.id, t.id), unclaimed, inArray(tickets.status, ["open", "in_progress"])))
      .returning({ id: tickets.id });
    return claimed.length > 0;
  }

  /** People who work the queue: members of a group with moderator or admin access to tickets, and of the admin group. */
  async staffIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: users.id, groupName: groups.name, tier: groupModuleAccess.tier })
      .from(users)
      .innerJoin(groupMemberships, eq(groupMemberships.userId, users.id))
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .leftJoin(groupModuleAccess, and(eq(groupModuleAccess.groupId, groups.id), eq(groupModuleAccess.moduleKey, "tickets")))
      .where(and(eq(users.isActive, true), isNull(users.deletedAt)));
    return [...new Set(rows.filter((r) => r.groupName === "admin" || r.tier === "moderator" || r.tier === "admin").map((r) => r.id))];
  }
}
