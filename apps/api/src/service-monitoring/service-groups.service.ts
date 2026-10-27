import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  commonStateMetrics,
  evaluateServiceGroup,
  groupCheckForSec,
  roleRuleProblem,
  serviceGroupRoleSchema,
  serviceGroupRuleId,
  stepGroupAlerts,
  type CheckAlertState,
  type ServiceGroup,
  type ServiceGroupCheck,
  type ServiceGroupCheckId,
  type ServiceGroupResult,
  type ServiceGroupRole,
  type ServiceGroupRoleChoices,
  type ServiceGroupSave,
  type ServiceGroupStatus,
  type ServiceInstance,
  stateMetricsOf,
} from "@church/shared";
import { dbErrorCode } from "@church/shared/db";
import { DB, type Db } from "../db/db.module";
import { availabilityHourly, monitorIncidents, serviceGroups, serviceInstances } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { SettingsService } from "../settings/settings.service";
import { InfraService } from "../infra/infra.service";
import { maintenanceActive } from "../monitors/maintenance";
import { ServiceMonitoringService } from "./service-monitoring.service";

type GroupRow = typeof serviceGroups.$inferSelect;

const TICK_MS = 30_000;
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const serviceGroupLink = (id: string) => `/monitoring/infra/service-groups/${id}`;

function roleOf(row: GroupRow): ServiceGroupRole | null {
  const parsed = serviceGroupRoleSchema.safeParse(row.roleRule);
  return parsed.success ? parsed.data : null;
}

/**
 * Service groups (docs/service-monitoring.md section 0): services on different hosts judged together. The rules are the pure
 * `evaluateServiceGroup` / `stepGroupAlerts` in packages/shared; this keeps the rows, and the `service-groups` cluster job
 * (30 s, one node) judges every group from its members' latest readings and opens or resolves the group's own incidents.
 * One open incident per group and rule is the database's rule (a partial unique index), so a handover can never open two.
 */
@Injectable()
export class ServiceGroupsService implements OnModuleInit {
  private readonly logger = new Logger(ServiceGroupsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly services: ServiceMonitoringService,
    private readonly infra: InfraService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "service-groups", everyMs: TICK_MS, initialDelayMs: 40_000, run: () => this.evaluateAll() });
  }

  // ---- reads ----

  async list(): Promise<ServiceGroup[]> {
    const rows = await this.db.select().from(serviceGroups).orderBy(asc(serviceGroups.name));
    return this.toDtos(rows);
  }

  async get(id: string): Promise<ServiceGroup> {
    return (await this.toDtos([await this.rowById(id)]))[0]!;
  }

  async incidents(id: string) {
    await this.rowById(id);
    return this.db
      .select()
      .from(monitorIncidents)
      .where(eq(monitorIncidents.serviceGroupId, id))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(50);
  }

  /** The choices for a role rule: the state metrics the members share, and each of their templates' own. */
  async roleChoices(instanceIds: string[]): Promise<ServiceGroupRoleChoices> {
    const members = instanceIds.length ? await this.services.toDto(await this.db.select().from(serviceInstances).where(inArray(serviceInstances.id, instanceIds))) : [];
    return this.stateChoices(members);
  }

  private async stateChoices(members: ServiceInstance[]): Promise<ServiceGroupRoleChoices> {
    const bodies = [];
    const templates: ServiceGroupRoleChoices["templates"] = [];
    const seen = new Set<string>();
    for (const m of members) {
      if (seen.has(m.templateKey)) continue;
      seen.add(m.templateKey);
      const body = await this.services.templateBody(m.templateKey);
      // A template that is gone reports nothing: it offers no states, so no role rule can pass for it.
      templates.push({ key: m.templateKey, name: m.templateName, metrics: body ? stateMetricsOf(body) : [] });
      if (body) bodies.push(body);
    }
    return { common: bodies.length === templates.length ? commonStateMetrics(bodies) : [], templates };
  }

  private async rowById(id: string): Promise<GroupRow> {
    const [row] = await this.db.select().from(serviceGroups).where(eq(serviceGroups.id, id)).limit(1);
    if (!row) throw new NotFoundException("No such service group");
    return row;
  }

  /** Share of the minute samples that found each group working, over the last day and week (availability history). */
  private async availability(ids: string[], now: Date): Promise<Map<string, { day: number | null; week: number | null }>> {
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const dayAgo = now.getTime() - 86_400_000;
    const rows = await this.db
      .select({ ref: availabilityHourly.ref, hour: availabilityHourly.hour, samples: availabilityHourly.samples, down: availabilityHourly.down })
      .from(availabilityHourly)
      .where(and(eq(availabilityHourly.kind, "service_group"), inArray(availabilityHourly.ref, ids), gte(availabilityHourly.hour, weekAgo)));
    const sums = new Map<string, { ds: number; dd: number; ws: number; wd: number }>();
    for (const r of rows) {
      const s = sums.get(r.ref) ?? { ds: 0, dd: 0, ws: 0, wd: 0 };
      const n = Number(r.samples);
      const d = Number(r.down);
      s.ws += n;
      s.wd += d;
      // An hour counts toward the day once any of it is inside the last 24 hours.
      if (r.hour.getTime() + 3_600_000 > dayAgo) {
        s.ds += n;
        s.dd += d;
      }
      sums.set(r.ref, s);
    }
    const pct = (samples: number, down: number) => (samples > 0 ? Math.round(((samples - down) / samples) * 10_000) / 100 : null);
    return new Map([...sums].map(([ref, s]) => [ref, { day: pct(s.ds, s.dd), week: pct(s.ws, s.wd) }]));
  }

  private async toDtos(rows: GroupRow[]): Promise<ServiceGroup[]> {
    if (!rows.length) return [];
    const now = new Date();
    const avail = await this.availability(rows.map((r) => r.id), now).catch(() => new Map<string, { day: number | null; week: number | null }>());
    const memberRows = await this.db
      .select()
      .from(serviceInstances)
      .where(inArray(serviceInstances.groupId, rows.map((r) => r.id)))
      .orderBy(asc(serviceInstances.name));
    const members = await this.services.toDto(memberRows);
    return rows.map((r) => {
      const mine = members.filter((m) => m.groupId === r.id);
      const role = roleOf(r);
      // Judged afresh for the page (members' readings change between the job's runs); the job's stored result decides
      // nothing here except which checks have an incident open.
      const result = evaluateServiceGroup({ minHealthy: r.minHealthy, role, redundancyAfterMin: r.redundancyAfterMin }, mine, now);
      const alertState = (r.alertState ?? {}) as Record<string, CheckAlertState>;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        minHealthy: r.minHealthy,
        role,
        forSec: r.forSec,
        alerts: r.alerts,
        redundancyAfterMin: r.redundancyAfterMin,
        showOnStatus: r.showOnStatus,
        statusName: r.statusName,
        status: result.status,
        counted: result.counted,
        working: result.working,
        roleCount: result.roleCount,
        checks: result.checks.map((c) => ({ ...c, open: !!alertState[c.id]?.open })),
        members: mine.map((m) => {
          const st = result.memberState[m.id];
          return {
            id: m.id,
            name: m.name,
            targetId: m.targetId,
            targetName: m.targetName,
            templateKey: m.templateKey,
            templateName: m.templateName,
            status: m.status,
            lastPolledAt: m.lastPolledAt,
            working: st?.working ?? false,
            stale: st?.stale ?? false,
            role: st?.role ?? null,
          };
        }),
        lastEvaluatedAt: iso(r.lastEvaluatedAt),
        availability: avail.get(r.id) ?? { day: null, week: null },
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  // ---- writes ----

  async create(input: ServiceGroupSave, userId: string): Promise<ServiceGroup> {
    await this.checkSave(input);
    let id: string;
    try {
      const [row] = await this.db
        .insert(serviceGroups)
        .values({
          name: input.name,
          description: input.description,
          minHealthy: input.minHealthy,
          roleRule: input.role,
          forSec: input.forSec,
          alerts: input.alerts,
          redundancyAfterMin: input.redundancyAfterMin,
          showOnStatus: input.showOnStatus,
          statusName: input.statusName || null,
          createdBy: userId,
        })
        .returning({ id: serviceGroups.id });
      id = row!.id;
    } catch (err) {
      if (dbErrorCode(err) === "23505") throw new ConflictException("A service group with that name already exists");
      throw err;
    }
    await this.setMembers(id, input.instanceIds);
    return this.get(id);
  }

  async update(id: string, input: ServiceGroupSave): Promise<ServiceGroup> {
    const row = await this.rowById(id);
    await this.checkSave(input);
    try {
      await this.db
        .update(serviceGroups)
        .set({
          name: input.name,
          description: input.description,
          minHealthy: input.minHealthy,
          roleRule: input.role,
          forSec: input.forSec,
          alerts: input.alerts,
          redundancyAfterMin: input.redundancyAfterMin,
          showOnStatus: input.showOnStatus,
          statusName: input.statusName || null,
          updatedAt: new Date(),
        })
        .where(eq(serviceGroups.id, row.id));
    } catch (err) {
      if (dbErrorCode(err) === "23505") throw new ConflictException("A service group with that name already exists");
      throw err;
    }
    await this.setMembers(id, input.instanceIds);
    return this.get(id);
  }

  async remove(id: string): Promise<{ id: string }> {
    await this.rowById(id);
    // Its incidents go with it (ON DELETE CASCADE); the members stay, in no group.
    await this.db.delete(serviceGroups).where(eq(serviceGroups.id, id));
    return { id };
  }

  /** The members named, and only them: a service taken off is left in no group, one added moves out of any other group. */
  private async setMembers(id: string, instanceIds: string[]): Promise<void> {
    const ids = [...new Set(instanceIds)];
    await this.db
      .update(serviceInstances)
      .set({ groupId: null })
      .where(and(eq(serviceInstances.groupId, id), ids.length ? notInArray(serviceInstances.id, ids) : undefined));
    if (ids.length) await this.db.update(serviceInstances).set({ groupId: id }).where(inArray(serviceInstances.id, ids));
  }

  private async checkSave(input: ServiceGroupSave): Promise<void> {
    const ids = [...new Set(input.instanceIds)];
    const rows = ids.length ? await this.db.select().from(serviceInstances).where(inArray(serviceInstances.id, ids)) : [];
    if (rows.length !== ids.length) throw new BadRequestException("A chosen service no longer exists");
    if (input.minHealthy !== null && ids.length && input.minHealthy > ids.length) {
      throw new BadRequestException(`At least ${input.minHealthy} working is more than the ${ids.length} service(s) in the group`);
    }
    if (input.role && ids.length) {
      // A role a member cannot report would read as "not MASTER" on that member, for ever: refuse it.
      const problem = roleRuleProblem(input.role, (await this.stateChoices(await this.services.toDto(rows))).templates);
      if (problem) throw new BadRequestException(problem);
    }
  }

  // ---- the job ----

  async evaluateAll(now: Date = new Date()): Promise<void> {
    const groups = await this.db.select().from(serviceGroups);
    if (!groups.length) return;
    const memberRows = await this.db.select().from(serviceInstances).where(inArray(serviceInstances.groupId, groups.map((g) => g.id)));
    const members = await this.services.toDto(memberRows);
    let silenced: boolean | null = null;
    for (const g of groups) {
      try {
        const result = evaluateServiceGroup({ minHealthy: g.minHealthy, role: roleOf(g), redundancyAfterMin: g.redundancyAfterMin }, members.filter((m) => m.groupId === g.id), now);
        const prev = (g.alertState ?? {}) as Record<string, CheckAlertState>;
        const step = stepGroupAlerts(result, prev, (check) => groupCheckForSec(g, check), now);
        for (const t of step.transitions) {
          const check = result.checks.find((c) => c.id === t.id);
          if (t.action === "open" && check) {
            silenced ??= await maintenanceActive(this.settings);
            const incidentId = await this.openIncident(g, check, silenced);
            step.state[t.id] = { ...step.state[t.id]!, open: true, incidentId };
          } else if (t.action === "resolve") {
            silenced ??= await maintenanceActive(this.settings);
            await this.resolveIncident(g, t.id as ServiceGroupCheckId, (step.state[t.id] ?? prev[t.id])?.incidentId ?? null, silenced);
          }
        }
        await this.db
          .update(serviceGroups)
          .set({ status: result.status, lastEvaluatedAt: now, lastResult: summarise(result), alertState: step.state })
          .where(eq(serviceGroups.id, g.id));
      } catch (err) {
        this.logger.warn(`service group ${g.id}: ${(err as Error).message}`);
      }
    }
  }

  private async openIncident(g: GroupRow, check: ServiceGroupCheck, silenced: boolean): Promise<string | null> {
    const ruleId = serviceGroupRuleId(check.id);
    try {
      const [inc] = await this.db
        .insert(monitorIncidents)
        .values({ serviceGroupId: g.id, ruleId, groupOpenRule: ruleId, reason: `${g.name}: ${check.text}`.slice(0, 500), detail: { group: g.id, groupName: g.name, check: check.id, severity: check.severity } })
        .returning({ id: monitorIncidents.id });
      await this.fanOut(g, "infra.alert.opened", `${g.name}: ${check.text}`, OPEN_BODY[check.id], silenced);
      return inc?.id ?? null;
    } catch (err) {
      // Already open (another node, or a run that died after opening it): adopt it, tell nobody again.
      if (dbErrorCode(err) !== "23505") throw err;
      const [open] = await this.db
        .select({ id: monitorIncidents.id })
        .from(monitorIncidents)
        .where(and(eq(monitorIncidents.serviceGroupId, g.id), eq(monitorIncidents.ruleId, ruleId), isNull(monitorIncidents.resolvedAt)))
        .limit(1);
      return open?.id ?? null;
    }
  }

  private async resolveIncident(g: GroupRow, check: ServiceGroupCheckId, incidentId: string | null, silenced: boolean): Promise<void> {
    const ended = await this.db
      .update(monitorIncidents)
      .set({ resolvedAt: new Date(), groupOpenRule: null })
      .where(
        and(
          isNull(monitorIncidents.resolvedAt),
          incidentId ? eq(monitorIncidents.id, incidentId) : and(eq(monitorIncidents.serviceGroupId, g.id), eq(monitorIncidents.ruleId, serviceGroupRuleId(check))),
        ),
      )
      .returning({ id: monitorIncidents.id });
    if (ended.length) await this.fanOut(g, "infra.alert.resolved", `${g.name} recovered`, RESOLVED_BODY[check], silenced);
  }

  private async fanOut(g: GroupRow, kind: string, title: string, body: string, silenced: boolean): Promise<void> {
    const link = serviceGroupLink(g.id);
    try {
      const recipients = silenced || !g.alerts ? [] : await this.infra.monitoringRecipientIds();
      if (recipients.length) {
        await this.notifications.createMany(recipients.map((id) => ({ recipientUserId: id, kind, title: title.slice(0, 200), body, link })));
      }
      await this.activity.record({ actorUserId: null, action: kind, resourceType: "service_group", resourceId: g.id, title: title.slice(0, 200), summary: body, link });
    } catch (err) {
      this.logger.warn(`service group alert fan-out failed: ${(err as Error).message}`);
    }
  }

  /** Counts for the home page and the overview: how many groups, and which are not up. */
  async summary(): Promise<{ total: number; byStatus: Record<ServiceGroupStatus, number> }> {
    const rows = await this.db
      .select({ status: serviceGroups.status, n: sql<number>`count(*)::int` })
      .from(serviceGroups)
      .groupBy(serviceGroups.status);
    const byStatus: Record<ServiceGroupStatus, number> = { unknown: 0, up: 0, degraded: 0, down: 0 };
    let total = 0;
    for (const r of rows) {
      const n = Number(r.n);
      total += n;
      if (r.status in byStatus) byStatus[r.status as ServiceGroupStatus] += n;
    }
    return { total, byStatus };
  }
}

const OPEN_BODY: Record<ServiceGroupCheckId, string> = {
  quorum: "Too few members are working.",
  role: "The members disagree about who holds the role.",
  redundancy: "It still works, but has lost its spare: one more loss and it is down.",
};
const RESOLVED_BODY: Record<ServiceGroupCheckId, string> = {
  quorum: "Enough members are working again.",
  role: "The role is held as it should be again.",
  redundancy: "Every member is working again.",
};

function summarise(r: ServiceGroupResult) {
  return { counted: r.counted, working: r.working, roleCount: r.roleCount, checks: r.checks };
}
