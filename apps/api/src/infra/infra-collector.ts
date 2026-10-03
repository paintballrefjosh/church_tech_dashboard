import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  BadRequestException,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { infraTargets, infraMetricSamples, infraEntities, monitorIncidents } from "../db/schema";
import { NotificationsService } from "../notifications/notifications.service";
import { ActivityService } from "../activity/activity.service";
import { SettingsService } from "../settings/settings.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { InfraService } from "./infra.service";
import { collect, discoverServices as discoverHostServices } from "./collectors/dispatch";
import { type CollectContext, type CollectResult } from "./collectors/types";
import type { InfraThresholdRule, InfraDiscoveredService } from "@church/shared";

const DEFAULT_TICK_SEC = parseInt(process.env.INFRA_TICK_SEC ?? "15", 10);
const DEFAULT_CONCURRENCY = parseInt(process.env.INFRA_CONCURRENCY ?? "6", 10);
const ROLLUP_MS = parseInt(process.env.INFRA_ROLLUP_MS ?? `${5 * 60_000}`, 10);

interface AlertEntry {
  breachingSince: string | null; // ISO
  open: boolean;
  incidentId: string | null;
}

@Injectable()
export class InfraCollector implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InfraCollector.name);
  private tickTimer: NodeJS.Timeout | null = null;
  private rollupTimer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  /** Previous poll's raw counters per target, for net/disk-IO rate math. */
  private readonly prev = new Map<string, Record<string, unknown>>();
  private concurrency = DEFAULT_CONCURRENCY;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly infra: InfraService,
    private readonly notifications: NotificationsService,
    private readonly activity: ActivityService,
    private readonly settings: SettingsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    // Runtime-tunable knobs (fall back to env / defaults). Read once at boot,
    // mirroring PrintersService — a settings change takes effect on restart.
    const tickSec = await this.getNumberSetting("monitoring.tick_seconds", DEFAULT_TICK_SEC);
    this.concurrency = await this.getNumberSetting("monitoring.poll_concurrency", DEFAULT_CONCURRENCY);
    // Stagger the first tick so we don't compete with boot / readiness.
    setTimeout(() => void this.tick().catch((e) => this.logger.warn(e)), 8_000);
    this.tickTimer = setInterval(
      () => void this.tick().catch((e) => this.logger.warn(e)),
      Math.max(5_000, tickSec * 1000),
    );
    this.rollupTimer = setInterval(
      () => void this.rollup().catch((e) => this.logger.warn(e)),
      ROLLUP_MS,
    );
  }

  private async getNumberSetting(key: string, fallback: number): Promise<number> {
    const raw = await this.settings.get(key);
    return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  }

  onModuleDestroy(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.rollupTimer) clearInterval(this.rollupTimer);
  }

  private async tick(): Promise<void> {
    const rows = await this.db.select().from(infraTargets).where(eq(infraTargets.enabled, true));
    const now = Date.now();
    const due = rows.filter((r) => {
      if (this.inFlight.has(r.id)) return false;
      if (!r.lastPolledAt) return true;
      return (now - r.lastPolledAt.getTime()) / 1000 >= r.intervalSec;
    });
    if (due.length === 0) return;

    let idx = 0;
    const workers = Array.from({ length: Math.min(this.concurrency, due.length) }, async () => {
      while (idx < due.length) {
        const target = due[idx++]!;
        this.inFlight.add(target.id);
        try {
          await this.pollTarget(target);
        } catch (err) {
          this.logger.warn(`poll ${target.name} (${target.id}) failed: ${(err as Error).message}`);
        } finally {
          this.inFlight.delete(target.id);
        }
      }
    });
    await Promise.all(workers);
  }

  /**
   * Force an immediate poll of one target, bypassing the interval-due check —
   * used by InfraUpdaterService right after an update run finishes, so the
   * "updates available" badge clears promptly instead of waiting out the
   * target's normal interval. Best-effort: silently skipped if a scheduled
   * poll for this target is already in flight, same as a tick() skip.
   */
  async pollNow(targetId: string): Promise<void> {
    if (this.inFlight.has(targetId)) return;
    const [row] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, targetId)).limit(1);
    if (!row || !row.enabled) return;
    this.inFlight.add(targetId);
    try {
      await this.pollTarget(row);
    } catch (err) {
      this.logger.warn(`pollNow ${row.name} (${row.id}) failed: ${(err as Error).message}`);
    } finally {
      this.inFlight.delete(targetId);
    }
  }

  private async loadContext(target: typeof infraTargets.$inferSelect): Promise<CollectContext> {
    const credential = await this.infra.getCredential(target.id);
    return {
      targetId: target.id,
      host: target.host,
      options: (target.options as CollectContext["options"]) ?? {},
      credential,
      knownHostKey: target.knownHostKey ?? null,
      prev: this.prev.get(target.id) ?? null,
    };
  }

  private async pollTarget(target: typeof infraTargets.$inferSelect): Promise<void> {
    const ctx = await this.loadContext(target);
    const result: CollectResult = await collect(ctx, target.os, target.capabilities as string[]);

    if (result.prev) this.prev.set(target.id, result.prev);
    await this.writeResults(target, result);
  }

  /**
   * On-demand service inventory for the "discover" picker on the target's
   * Services card — a one-off SSH probe, not part of the regular poll cycle.
   */
  async discoverServices(targetId: string): Promise<InfraDiscoveredService[]> {
    const [row] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, targetId)).limit(1);
    if (!row) throw new NotFoundException("Infrastructure target not found");
    const ctx = await this.loadContext(row);
    try {
      return await discoverHostServices(ctx, row.os);
    } catch (err) {
      // Surface the real SSH/connect failure (e.g. auth, timeout) rather than
      // a bare 500 — the picker's error line shows this verbatim.
      throw new BadRequestException((err as Error).message || "Service discovery failed");
    }
  }

  private async writeResults(
    target: typeof infraTargets.$inferSelect,
    result: CollectResult,
  ): Promise<void> {
    const now = new Date();

    if (result.ok) {
      // Target-level time-series row.
      await this.db.insert(infraMetricSamples).values({
        targetId: target.id,
        entityKind: "target",
        entityId: "",
        ts: now,
        cpuPct: result.target.cpuPct,
        memPct: result.target.memPct,
        diskPctMax: result.target.diskPctMax,
        metrics: result.target.metrics,
      });

      // Entity time-series rows (batched).
      const entitySamples = result.entities
        .filter((e) => e.sample)
        .map((e) => ({
          targetId: target.id,
          entityKind: e.entityKind,
          entityId: e.externalId,
          ts: now,
          cpuPct: e.sample!.cpuPct,
          memPct: e.sample!.memPct,
          diskPctMax: e.sample!.diskPctMax,
          metrics: e.sample!.metrics,
        }));
      if (entitySamples.length) await this.db.insert(infraMetricSamples).values(entitySamples);

      // Upsert discovered entities; mark anything not seen this poll absent.
      await this.db
        .update(infraEntities)
        .set({ present: false })
        .where(eq(infraEntities.targetId, target.id));
      for (const e of result.entities) {
        await this.db
          .insert(infraEntities)
          .values({
            targetId: target.id,
            entityKind: e.entityKind,
            externalId: e.externalId,
            name: e.name,
            groupKey: e.groupKey ?? null,
            status: e.status,
            health: e.health ?? null,
            state: e.state,
            present: true,
            lastSeenAt: now,
          })
          .onConflictDoUpdate({
            target: [infraEntities.targetId, infraEntities.entityKind, infraEntities.externalId],
            set: {
              name: e.name,
              groupKey: e.groupKey ?? null,
              status: e.status,
              health: e.health ?? null,
              state: e.state,
              present: true,
              lastSeenAt: now,
            },
          });
      }
    }

    // Denormalised current state on the target row.
    await this.db
      .update(infraTargets)
      .set({
        status: !result.ok ? "down" : result.warning ? "degraded" : "up",
        lastPolledAt: now,
        lastError: result.ok ? result.warning ?? null : result.error ?? "poll failed",
        lastSample: result.ok
          ? {
              cpuPct: result.target.cpuPct,
              memPct: result.target.memPct,
              diskPctMax: result.target.diskPctMax,
              metrics: result.target.metrics,
              ts: now.toISOString(),
            }
          : target.lastSample,
        // TOFU: persist the SSH host key the first time we see it.
        knownHostKey: !target.knownHostKey && result.hostKey ? result.hostKey : target.knownHostKey,
        updatedAt: now,
      })
      .where(eq(infraTargets.id, target.id));

    if (result.ok) await this.evaluateThresholds(target, result, now);

    // Nudge anyone watching the Infrastructure tab to pull fresh state. A
    // signal (not a delta) because the overview's up/degraded/down summary is
    // cheaper to recompute from a refetch than to reconcile field-by-field.
    this.realtime.toRoom("infra", "infra:update", { targetId: target.id });
    this.realtime.toRoom(`infra:${target.id}`, "infra:update", { targetId: target.id });
  }

  // ---- threshold alerting (reuses monitor_incidents + notifications + activity) ----

  private async evaluateThresholds(
    target: typeof infraTargets.$inferSelect,
    result: CollectResult,
    now: Date,
  ): Promise<void> {
    const rules = (target.thresholds as InfraThresholdRule[]) ?? [];
    if (rules.length === 0) return;
    const state = { ...((target.alertState as Record<string, AlertEntry>) ?? {}) };
    let changed = false;
    let degraded = false;

    for (const rule of rules) {
      // v1 evaluates target-level scalars + dotted metric paths.
      const value = resolveMetric(result.target, rule.metricPath);
      if (value === null) continue;
      const breaching = compare(value, rule.op, rule.value);
      const entry: AlertEntry = state[rule.id] ?? { breachingSince: null, open: false, incidentId: null };

      if (breaching) {
        degraded = true;
        if (!entry.breachingSince) entry.breachingSince = now.toISOString();
        const heldMs = now.getTime() - new Date(entry.breachingSince).getTime();
        if (!entry.open && heldMs >= rule.forSec * 1000) {
          const incidentId = await this.openIncident(target, rule, value);
          entry.open = true;
          entry.incidentId = incidentId;
        }
        state[rule.id] = entry;
        changed = true;
      } else if (entry.breachingSince || entry.open) {
        if (entry.open) await this.resolveIncident(target, rule, entry.incidentId, value);
        state[rule.id] = { breachingSince: null, open: false, incidentId: null };
        changed = true;
      }
    }

    const patch: Partial<typeof infraTargets.$inferInsert> = {};
    if (changed) patch.alertState = state;
    // Reflect an active breach as "degraded" without masking a hard "down".
    if (degraded && target.status !== "down") patch.status = "degraded";
    if (Object.keys(patch).length) {
      await this.db.update(infraTargets).set(patch).where(eq(infraTargets.id, target.id));
    }
  }

  private async openIncident(
    target: typeof infraTargets.$inferSelect,
    rule: InfraThresholdRule,
    observed: number,
  ): Promise<string | null> {
    const reason = `${rule.metricPath} ${rule.op} ${rule.value} (observed ${round(observed)})`;
    const [inc] = await this.db
      .insert(monitorIncidents)
      .values({
        targetId: target.id,
        ruleId: rule.id,
        reason,
        detail: { metric: rule.metricPath, op: rule.op, threshold: rule.value, observed, severity: rule.severity },
      })
      .returning();
    const title = `${target.name}: ${rule.metricPath} ${rule.op} ${rule.value}`;
    const body = `Observed ${round(observed)} (${rule.severity}).`;
    await this.fanOut("infra.alert.opened", title, body, `/monitoring/infra/${target.id}`, target.id);
    return inc?.id ?? null;
  }

  private async resolveIncident(
    target: typeof infraTargets.$inferSelect,
    rule: InfraThresholdRule,
    incidentId: string | null,
    observed: number,
  ): Promise<void> {
    if (incidentId) {
      await this.db
        .update(monitorIncidents)
        .set({ resolvedAt: new Date() })
        .where(eq(monitorIncidents.id, incidentId));
    }
    const title = `${target.name}: ${rule.metricPath} recovered`;
    const body = `Back within threshold (observed ${round(observed)}).`;
    await this.fanOut("infra.alert.resolved", title, body, `/monitoring/infra/${target.id}`, target.id);
  }

  private async fanOut(kind: string, title: string, body: string, link: string, targetId: string): Promise<void> {
    try {
      // Maintenance mode silences the notification fan-out only; the incident
      // and the activity-feed entry below still record so history is intact.
      const silenced = (await this.settings.get("monitoring.maintenance_mode")) === true;
      const recipientIds = silenced ? [] : await this.infra.monitoringRecipientIds();
      if (recipientIds.length) {
        await this.notifications.createMany(
          recipientIds.map((id) => ({ recipientUserId: id, kind, title, body, link })),
        );
      }
      await this.activity.record({
        actorUserId: null,
        action: kind,
        resourceType: "infra_target",
        resourceId: targetId,
        title,
        summary: body,
        link,
      });
    } catch (err) {
      this.logger.warn(`infra alert fan-out failed: ${(err as Error).message}`);
    }
  }

  // ---- rollups ----

  /**
   * Aggregate raw samples into 5m and 1h min/avg/max buckets. Server-side
   * INSERT..SELECT..GROUP BY so no rows travel to Node; ON CONFLICT keeps the
   * most-recent aggregate for buckets still filling.
   */
  private async rollup(): Promise<void> {
    await this.rollupBucket("5m", 300, 15 * 60_000);
    await this.rollupBucket("1h", 3600, 2 * 3_600_000);
  }

  private async rollupBucket(bucket: string, seconds: number, lookbackMs: number): Promise<void> {
    const since = new Date(Date.now() - lookbackMs);
    // Compute the bucket start in an inner subquery under a distinct name
    // (bucket_ts), then GROUP BY that plain column. Doing the flooring inline in
    // both the SELECT (aliased AS ts) and the GROUP BY made CockroachDB fail to
    // match the grouped expression to the projection — because the alias `ts`
    // collided with the raw source column `ts` the expression references — so it
    // reported `column "ts" must appear in the GROUP BY clause`. Grouping by a
    // pre-computed, differently-named column removes the ambiguity and is
    // portable to both Cockroach and Postgres.
    await this.db.execute(sql`
      INSERT INTO infra_metric_rollups (target_id, entity_kind, entity_id, bucket, ts, metrics, samples)
      SELECT
        target_id, entity_kind, entity_id, ${bucket} AS bucket,
        bucket_ts AS ts,
        jsonb_build_object(
          'cpuPct', jsonb_build_object('min', min(cpu_pct), 'avg', avg(cpu_pct), 'max', max(cpu_pct)),
          'memPct', jsonb_build_object('min', min(mem_pct), 'avg', avg(mem_pct), 'max', max(mem_pct)),
          'diskPctMax', jsonb_build_object('min', min(disk_pct_max), 'avg', avg(disk_pct_max), 'max', max(disk_pct_max)),
          'loadOne', jsonb_build_object('min', min(load_one), 'avg', avg(load_one), 'max', max(load_one)),
          'loadFive', jsonb_build_object('min', min(load_five), 'avg', avg(load_five), 'max', max(load_five)),
          'loadFifteen', jsonb_build_object('min', min(load_fifteen), 'avg', avg(load_fifteen), 'max', max(load_fifteen)),
          'temperatureC', jsonb_build_object('min', min(temp_c), 'avg', avg(temp_c), 'max', max(temp_c))
        ) AS metrics,
        count(*)::int AS samples
      FROM (
        SELECT
          target_id, entity_kind, entity_id, cpu_pct, mem_pct, disk_pct_max,
          (metrics->'load'->>'one')::float8 AS load_one,
          (metrics->'load'->>'five')::float8 AS load_five,
          (metrics->'load'->>'fifteen')::float8 AS load_fifteen,
          (metrics->>'temperatureC')::float8 AS temp_c,
          to_timestamp(floor(extract('epoch' from ts)::float8 / ${seconds}) * ${seconds})::timestamp AS bucket_ts
        FROM infra_metric_samples
        WHERE ts >= ${since}
      ) s
      GROUP BY target_id, entity_kind, entity_id, bucket_ts
      ON CONFLICT (target_id, entity_kind, entity_id, bucket, ts)
      DO UPDATE SET metrics = excluded.metrics, samples = excluded.samples
    `);
  }
}

function resolveMetric(
  target: CollectResult["target"],
  path: string,
): number | null {
  if (path === "cpuPct") return target.cpuPct;
  if (path === "memPct") return target.memPct;
  if (path === "diskPctMax") return target.diskPctMax;
  // Dotted path into the metrics blob, e.g. "load.one".
  let cur: unknown = target.metrics;
  for (const part of path.split(".")) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return typeof cur === "number" ? cur : null;
}

function compare(a: number, op: InfraThresholdRule["op"], b: number): boolean {
  switch (op) {
    case ">":
      return a > b;
    case ">=":
      return a >= b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case "==":
      return a === b;
    default:
      return false;
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
