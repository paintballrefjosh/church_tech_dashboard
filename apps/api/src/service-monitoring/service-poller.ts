import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  evaluateService,
  fillText,
  serviceStatus,
  stepCheckAlerts,
  type CheckAlertState,
  type CounterReading,
  type ServiceInputValue,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { infraTargets, monitorIncidents, serviceInstances, serviceMetricSamples } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { SettingsService } from "../settings/settings.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { InfraService } from "../infra/infra.service";
import { maintenanceActive } from "../monitors/maintenance";
import { UnreadableSecretError } from "../settings/crypto";
import { ServiceMonitoringService, serviceRuleId, type InstanceRow } from "./service-monitoring.service";

const TICK_MS = 10_000;
const CLAIM_SEC = 180;
const MAX_AT_ONCE = 4;
const ROLLUP_MS = 5 * 60_000;
const PRUNE_MS = 60 * 60_000;
// The same windows as infra metrics: raw readings back the 24-hour charts, the summaries the longer ones.
const RETAIN_RAW_DAYS = 7;
const RETAIN_5M_DAYS = 90;
const RETAIN_1H_DAYS = 365;
const PRUNE_BATCH = 5_000;
const PRUNE_MAX_BATCHES = 100;

/**
 * Polls service instances (docs/service-monitoring.md section 5). Cluster jobs, so one node does each pass; an instance is
 * CLAIMED with `claimed_until` before it is read, so a handover mid-poll never reads it twice. Counters and per-check alert
 * state live on the instance row, so the next node carries on with correct rates. A check that holds for its time opens a
 * normal `monitor_incident` on the host (rule `svc:<instance>:<check>`) with the infra alert notices, silenced by
 * maintenance mode; the incident is still recorded.
 */
@Injectable()
export class ServicePoller implements OnModuleInit {
  private readonly logger = new Logger(ServicePoller.name);
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly services: ServiceMonitoringService,
    private readonly infra: InfraService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "service-poll", everyMs: TICK_MS, initialDelayMs: 25_000, run: () => this.tick() });
    this.jobs.register({ name: "service-rollup", everyMs: ROLLUP_MS, run: () => this.rollup() });
    this.jobs.register({ name: "service-prune", everyMs: PRUNE_MS, initialDelayMs: 10 * 60_000, run: () => this.prune() });
  }

  async tick(): Promise<void> {
    const room = MAX_AT_ONCE - this.inFlight.size;
    if (room <= 0) return;
    const due = await this.db.execute(sql`
      SELECT si.id FROM service_instances si JOIN infra_targets t ON t.id = si.target_id
      WHERE si.enabled AND t.enabled
        AND (si.claimed_until IS NULL OR si.claimed_until < now())
        AND (si.last_polled_at IS NULL OR si.last_polled_at < now() - (si.interval_sec * INTERVAL '1 second'))
      ORDER BY si.last_polled_at NULLS FIRST
      LIMIT ${room * 2}`);
    const ids = (due.rows as Array<{ id: string }>).map((r) => r.id).filter((id) => !this.inFlight.has(id));
    await Promise.all(ids.slice(0, room).map((id) => this.claimAndPoll(id)));
  }

  /** "Check now" on the service's page. False when it is being read already. */
  async pollNow(id: string): Promise<boolean> {
    if (this.inFlight.has(id)) return false;
    return this.claimAndPoll(id);
  }

  private async claimAndPoll(id: string): Promise<boolean> {
    this.inFlight.add(id);
    try {
      const claimed = await this.db
        .update(serviceInstances)
        .set({ claimedUntil: sql`now() + (${CLAIM_SEC}::int * INTERVAL '1 second')` })
        .where(and(eq(serviceInstances.id, id), or(isNull(serviceInstances.claimedUntil), lt(serviceInstances.claimedUntil, sql`now()`))))
        .returning();
      if (!claimed.length) return false;
      try {
        await this.poll(claimed[0]!);
      } catch (err) {
        const message = err instanceof UnreadableSecretError ? err.message : `The check failed: ${(err as Error).message}`;
        this.logger.warn(`service ${id}: ${(err as Error).message}`);
        await this.db.update(serviceInstances).set({ status: "down", lastError: message.slice(0, 500), lastPolledAt: new Date() }).where(eq(serviceInstances.id, id));
      } finally {
        await this.db.update(serviceInstances).set({ claimedUntil: null }).where(eq(serviceInstances.id, id));
      }
      return true;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async poll(row: InstanceRow): Promise<void> {
    const [target] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, row.targetId)).limit(1);
    if (!target) return;
    const body = await this.services.templateBody(row.templateKey);
    if (!body) {
      await this.db.update(serviceInstances).set({ status: "down", lastError: `The template "${row.templateKey}" no longer exists`, lastPolledAt: new Date() }).where(eq(serviceInstances.id, row.id));
      return;
    }
    const { ctx, exprInputs } = await this.services.runContext(target, body, (row.inputs ?? {}) as Record<string, ServiceInputValue>, row.secretsEnc ?? {});
    const { outcomes } = await this.services.collect(body, ctx, false);
    const now = new Date();
    const result = evaluateService(body, outcomes, exprInputs, (row.counters as Record<string, CounterReading> | null) ?? {}, now.getTime());
    const prevAlerts = (row.alertState as Record<string, CheckAlertState> | null) ?? {};
    const step = stepCheckAlerts(body, result, prevAlerts, now);
    const state = step.state;

    for (const t of step.transitions) {
      const check = body.checks.find((c) => c.id === t.id);
      const entry = state[t.id] ?? prevAlerts[t.id];
      if (t.action === "open" && check) {
        const text = result.checks.find((c) => c.id === t.id)?.text ?? check.text;
        const incidentId = await this.openIncident(target, row, check.id, check.severity, text);
        state[t.id] = { ...(state[t.id] ?? { breachingSince: now.toISOString(), incidentId: null }), open: true, incidentId };
      } else if (t.action === "resolve") {
        await this.resolveIncident(target, row, t.id, entry?.incidentId ?? null, check ? fillText(check.text, () => null) : t.id);
      }
    }

    const openIds = new Set(Object.entries(state).filter(([, s]) => s.open).map(([id]) => id));
    const errors = Object.entries(result.errors);
    const lastError = result.down ? errors.map(([k, e]) => `${k}: ${e}`).join("; ").slice(0, 500) : errors.length ? `(optional) ${errors.map(([k, e]) => `${k}: ${e}`).join("; ")}`.slice(0, 500) : null;

    // An unreachable service records nothing: no data, never zeros.
    const numeric = Object.fromEntries(Object.entries(result.values).filter(([, v]) => typeof v === "number" && Number.isFinite(v))) as Record<string, number>;
    if (!result.down && Object.keys(numeric).length) {
      await this.db.insert(serviceMetricSamples).values({ instanceId: row.id, ts: now, values: numeric }).onConflictDoNothing();
    }
    await this.db
      .update(serviceInstances)
      .set({
        status: serviceStatus(result, openIds),
        lastError,
        lastPolledAt: now,
        // A down poll keeps the last good reading on show (the page says how old it is).
        ...(result.down
          ? {}
          : {
              lastValues: result.values,
              lastStates: result.states,
              members: result.members,
              membersOmitted: result.membersOmitted,
              checks: result.checks,
              counters: { ...((row.counters as Record<string, CounterReading> | null) ?? {}), ...result.counters },
            }),
        collectorErrors: result.errors,
        alertState: state,
      })
      .where(eq(serviceInstances.id, row.id));

    this.realtime.toRoom(`infra:${target.id}`, "infra:update", { targetId: target.id, serviceInstanceId: row.id });
  }

  private async openIncident(target: typeof infraTargets.$inferSelect, row: InstanceRow, checkId: string, severity: string, text: string): Promise<string | null> {
    const [inc] = await this.db
      .insert(monitorIncidents)
      .values({
        targetId: target.id,
        ruleId: serviceRuleId(row.id, checkId),
        reason: `${row.name}: ${text}`.slice(0, 500),
        detail: { service: row.id, serviceName: row.name, template: row.templateKey, check: checkId, severity },
      })
      .returning({ id: monitorIncidents.id });
    await this.fanOut("infra.alert.opened", `${target.name}: ${row.name}: ${text}`, `${severity === "critical" ? "Critical" : "Warning"} on ${row.name}.`, target.id, row.id);
    return inc?.id ?? null;
  }

  private async resolveIncident(target: typeof infraTargets.$inferSelect, row: InstanceRow, checkId: string, incidentId: string | null, label: string): Promise<void> {
    await this.db
      .update(monitorIncidents)
      .set({ resolvedAt: new Date() })
      .where(
        incidentId
          ? eq(monitorIncidents.id, incidentId)
          : and(eq(monitorIncidents.targetId, target.id), eq(monitorIncidents.ruleId, serviceRuleId(row.id, checkId)), isNull(monitorIncidents.resolvedAt)),
      );
    await this.fanOut("infra.alert.resolved", `${target.name}: ${row.name} recovered`, `${label}: back to normal.`, target.id, row.id);
  }

  private async fanOut(kind: string, title: string, body: string, targetId: string, instanceId: string): Promise<void> {
    const link = `/monitoring/infra/${targetId}/services/${instanceId}`;
    try {
      const silenced = await maintenanceActive(this.settings);
      const recipients = silenced ? [] : await this.infra.monitoringRecipientIds();
      if (recipients.length) {
        await this.notifications.createMany(recipients.map((id) => ({ recipientUserId: id, kind, title: title.slice(0, 200), body, link })));
      }
      await this.activity.record({ actorUserId: null, action: kind, resourceType: "infra_target", resourceId: targetId, title: title.slice(0, 200), summary: body, link });
    } catch (err) {
      this.logger.warn(`service alert fan-out failed: ${(err as Error).message}`);
    }
  }

  // ---- summaries and retention ----

  /**
   * 5-minute and hourly min/avg/max per metric, in the database: one row per (instance, bucket, metric). The bucket start is
   * computed in a subquery under its own name (see InfraCollector.rollupBucket for why CockroachDB needs that).
   */
  async rollup(): Promise<void> {
    for (const [bucket, seconds, lookbackMs] of [["5m", 300, 15 * 60_000], ["1h", 3600, 2 * 3_600_000]] as const) {
      const since = new Date(Date.now() - lookbackMs);
      await this.db.execute(sql`
        INSERT INTO service_metric_rollups (instance_id, bucket, ts, metric, min, avg, max, samples)
        SELECT instance_id, ${bucket} AS bucket, bucket_ts AS ts, metric, min(v), avg(v), max(v), count(*)::int
        FROM (
          SELECT s.instance_id, e.key AS metric, e.value::text::float8 AS v,
            to_timestamp(floor(extract('epoch' from s.ts)::float8 / ${seconds}) * ${seconds})::timestamp AS bucket_ts
          FROM service_metric_samples s, jsonb_each(s."values") e
          WHERE s.ts >= ${since} AND jsonb_typeof(e.value) = 'number'
        ) x
        GROUP BY instance_id, bucket_ts, metric
        ON CONFLICT (instance_id, bucket, ts, metric)
        DO UPDATE SET min = excluded.min, avg = excluded.avg, max = excluded.max, samples = excluded.samples
      `);
    }
  }

  async prune(): Promise<void> {
    const day = 86_400_000;
    const now = Date.now();
    let removed = await this.pruneBatches(
      (cutoff) => sql`
        DELETE FROM service_metric_samples WHERE (instance_id, ts) IN (
          SELECT instance_id, ts FROM service_metric_samples WHERE ts < ${cutoff} LIMIT ${PRUNE_BATCH})`,
      new Date(now - RETAIN_RAW_DAYS * day),
    );
    for (const [bucket, days] of [["5m", RETAIN_5M_DAYS], ["1h", RETAIN_1H_DAYS]] as const) {
      removed += await this.pruneBatches(
        (cutoff) => sql`
          DELETE FROM service_metric_rollups WHERE (instance_id, bucket, ts, metric) IN (
            SELECT instance_id, bucket, ts, metric FROM service_metric_rollups WHERE bucket = ${bucket} AND ts < ${cutoff} LIMIT ${PRUNE_BATCH})`,
        new Date(now - days * day),
      );
    }
    if (removed > 0) this.logger.log(`pruned ${removed} service readings`);
  }

  private async pruneBatches(stmt: (cutoff: Date) => ReturnType<typeof sql>, cutoff: Date): Promise<number> {
    let total = 0;
    for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
      const res = await this.db.execute(stmt(cutoff));
      const n = (res as { rowCount?: number | null }).rowCount ?? 0;
      total += n;
      if (n < PRUNE_BATCH) break;
    }
    return total;
  }
}
