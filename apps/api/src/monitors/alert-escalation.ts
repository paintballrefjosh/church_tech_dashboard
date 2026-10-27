import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import {
  ALERT_KEYS,
  ESCALATION_MAX_AGE_HOURS,
  describeMinutes,
  escalationConfig,
  escalationDue,
  monitorAlertsOff,
  type EscalationConfig,
  type EscalationLevel,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { groupMemberships, groups, infraTargets, monitorIncidents, monitors, serviceGroups, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { InfraService } from "../infra/infra.service";
import { maintenanceActive } from "./maintenance";

export interface EscalationResult {
  /** Notices sent, by step. */
  reminders: number;
  escalations: number;
}

/**
 * Escalation of incidents nobody has acknowledged (monitors and infrastructure alike, they share `monitor_incidents`).
 * After `monitoring.escalate_reminder_min` the usual alert recipients are told again; after `monitoring.escalate_group_min`
 * the group named in `monitoring.escalation_group` is told too. Each step happens once per incident, and acknowledging or
 * resolving it ends the sequence. Nothing is sent during maintenance mode.
 *
 * A step is claimed with one conditional UPDATE before anything is sent, so two nodes (a handover, or a job that overlaps
 * itself) never send the same step twice; the cost is that a crash between claim and send loses that one notice, which is
 * the right way round for something that repeats nothing.
 */
@Injectable()
export class AlertEscalation implements OnModuleInit {
  private readonly logger = new Logger(AlertEscalation.name);
  private warnedGroup: string | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly infra: InfraService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "alert-escalation", everyMs: 60_000, initialDelayMs: 45_000, run: async () => void (await this.run()) });
  }

  async config(): Promise<EscalationConfig> {
    const [reminder, group, name] = await Promise.all([
      this.settings.get(ALERT_KEYS.reminderAfterMin).catch(() => 0),
      this.settings.get(ALERT_KEYS.groupAfterMin).catch(() => 0),
      this.settings.get(ALERT_KEYS.escalationGroup).catch(() => ""),
    ]);
    return escalationConfig(reminder, group, name);
  }

  async run(now: Date = new Date()): Promise<EscalationResult> {
    const result: EscalationResult = { reminders: 0, escalations: 0 };
    const config = await this.config();
    if (config.reminderMin === 0 && config.groupMin === 0) return result;
    if (await maintenanceActive(this.settings)) return result;

    let groupMembers: string[] = [];
    if (config.groupMin > 0) {
      groupMembers = await this.groupMemberIds(config.group);
      if (groupMembers.length === 0) {
        // A typo or an emptied group must not make the whole escalation silently do nothing: say so once, send the reminder.
        if (this.warnedGroup !== config.group) {
          this.warnedGroup = config.group;
          this.logger.warn(`escalation group "${config.group}" does not exist or has no active members: only reminders are sent`);
        }
        config.groupMin = 0;
      } else {
        this.warnedGroup = null;
      }
    }

    const since = new Date(now.getTime() - ESCALATION_MAX_AGE_HOURS * 3_600_000);
    const open = await this.db
      .select({
        id: monitorIncidents.id,
        startedAt: monitorIncidents.startedAt,
        resolvedAt: monitorIncidents.resolvedAt,
        acknowledgedAt: monitorIncidents.acknowledgedAt,
        escalationLevel: monitorIncidents.escalationLevel,
        reason: monitorIncidents.reason,
        monitorId: monitorIncidents.monitorId,
        targetId: monitorIncidents.targetId,
        serviceGroupId: monitorIncidents.serviceGroupId,
        monitorName: monitors.name,
        monitorOptions: monitors.options,
        targetName: infraTargets.name,
        groupName: serviceGroups.name,
        groupAlerts: serviceGroups.alerts,
      })
      .from(monitorIncidents)
      .leftJoin(monitors, eq(monitors.id, monitorIncidents.monitorId))
      .leftJoin(infraTargets, eq(infraTargets.id, monitorIncidents.targetId))
      .leftJoin(serviceGroups, eq(serviceGroups.id, monitorIncidents.serviceGroupId))
      .where(
        and(
          isNull(monitorIncidents.resolvedAt),
          isNull(monitorIncidents.acknowledgedAt),
          lt(monitorIncidents.escalationLevel, 2),
          gte(monitorIncidents.startedAt, since),
        ),
      );

    let usual: string[] | null = null;
    for (const inc of open) {
      // A monitor with alerts off never sent the first notice, so there is nothing to remind anyone about.
      if (monitorAlertsOff(inc.monitorOptions as Record<string, unknown> | null) || inc.groupAlerts === false) continue;
      const level = escalationDue(inc, config, now);
      if (!level) continue;
      if (!(await this.claim(inc.id, level, now))) continue;

      const subject = inc.monitorName ?? inc.targetName ?? inc.groupName ?? "An alert";
      const age = describeMinutes(now.getTime() - inc.startedAt.getTime());
      const reason = inc.reason ? ` ${inc.reason}` : "";
      const ownLink = inc.monitorId
        ? `/monitoring/${inc.monitorId}`
        : inc.targetId
          ? `/monitoring/infra/${inc.targetId}`
          : inc.serviceGroupId
            ? `/monitoring/infra/service-groups/${inc.serviceGroupId}`
            : "/monitoring";

      let recipients: string[];
      let link: string;
      let title: string;
      if (level === 1) {
        usual ??= await this.infra.monitoringRecipientIds();
        recipients = usual;
        link = ownLink;
        title = `Still unresolved: ${subject}`;
        result.reminders++;
      } else {
        // The second group is told in addition to the usual recipients, unless the reminder already went to them.
        usual ??= await this.infra.monitoringRecipientIds();
        recipients = inc.escalationLevel >= 1 ? groupMembers : [...new Set([...usual, ...groupMembers])];
        link = "/status";
        title = `Needs attention: ${subject}`;
        result.escalations++;
      }
      const body = `Open for ${age} and nobody has acknowledged it.${reason}`.slice(0, 1000);
      await this.notifications.createMany(recipients.map((id) => ({ recipientUserId: id, kind: "monitor.incident.escalated", title, body, link })));
      await this.activity.record({
        actorUserId: null,
        action: "monitor.incident.escalated",
        resourceType: inc.monitorId ? "monitor" : inc.serviceGroupId ? "service_group" : "infra_target",
        resourceId: inc.monitorId ?? inc.targetId ?? inc.serviceGroupId ?? inc.id,
        title,
        summary: body,
        link: ownLink,
      });
    }
    if (result.reminders + result.escalations > 0) {
      this.logger.log(`escalated unacknowledged incidents: ${result.reminders} reminder(s), ${result.escalations} to the second group`);
    }
    return result;
  }

  /** Take a step for an incident; true for the one caller that got it. */
  private async claim(id: string, level: EscalationLevel, now: Date): Promise<boolean> {
    const rows = await this.db
      .update(monitorIncidents)
      .set({ escalationLevel: level, escalatedAt: now })
      .where(
        and(
          eq(monitorIncidents.id, id),
          lt(monitorIncidents.escalationLevel, level),
          isNull(monitorIncidents.acknowledgedAt),
          isNull(monitorIncidents.resolvedAt),
        ),
      )
      .returning({ id: monitorIncidents.id });
    return rows.length > 0;
  }

  private async groupMemberIds(name: string): Promise<string[]> {
    if (!name) return [];
    const rows = await this.db
      .select({ id: users.id })
      .from(groups)
      .innerJoin(groupMemberships, eq(groupMemberships.groupId, groups.id))
      .innerJoin(users, eq(users.id, groupMemberships.userId))
      .where(and(eq(groups.name, name), eq(users.isActive, true), isNull(users.deletedAt)));
    // Group names are not unique in the schema: the same person must not be told twice.
    return [...new Set(rows.map((r) => r.id))];
  }
}
