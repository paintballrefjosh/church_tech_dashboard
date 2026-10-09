import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, lte, isNull, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import {
  infraTargets,
  infraTargetCredentials,
  infraMetricSamples,
  infraMetricRollups,
  infraEntities,
  monitorIncidents,
  users,
  groups,
  groupMemberships,
  groupModuleAccess,
} from "../db/schema";
import { encryptSecret, decryptStoredSecret } from "../settings/crypto";
import type {
  InfraTarget,
  CreateInfraTargetInput,
  UpdateInfraTargetInput,
  InfraEntity,
  InfraSeriesResponse,
  InfraSummary,
  InfraOs,
  InfraCapability,
  InfraStatus,
  InfraEntityKind,
  InfraAuthType,
} from "@church/shared";
import type { DecryptedCredential } from "./collectors/types";

const MAX_POINTS = 500;

@Injectable()
export class InfraService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ---- CRUD ----

  async list(): Promise<InfraTarget[]> {
    const rows = await this.db.select().from(infraTargets).orderBy(asc(infraTargets.name));
    const creds = await this.db
      .select({ targetId: infraTargetCredentials.targetId, authType: infraTargetCredentials.authType })
      .from(infraTargetCredentials);
    const credByTarget = new Map(creds.map((c) => [c.targetId, c.authType]));
    return rows.map((r) => toTarget(r, credByTarget.get(r.id) ?? null));
  }

  async getById(id: string): Promise<InfraTarget> {
    const row = await this.rowById(id);
    const [cred] = await this.db
      .select({ authType: infraTargetCredentials.authType })
      .from(infraTargetCredentials)
      .where(eq(infraTargetCredentials.targetId, id))
      .limit(1);
    return toTarget(row, cred?.authType ?? null);
  }

  private async rowById(id: string): Promise<typeof infraTargets.$inferSelect> {
    const [row] = await this.db.select().from(infraTargets).where(eq(infraTargets.id, id)).limit(1);
    if (!row) throw new NotFoundException("Infrastructure target not found");
    return row;
  }

  async create(input: CreateInfraTargetInput): Promise<InfraTarget> {
    const capabilities = input.capabilities ?? [];
    const [row] = await this.db
      .insert(infraTargets)
      .values({
        name: input.name.trim(),
        os: input.os,
        capabilities,
        kind: deriveKind(input.os, capabilities),
        host: input.host.trim(),
        enabled: input.enabled ?? true,
        intervalSec: input.intervalSec ?? 30,
        options: input.options ?? {},
        thresholds: input.thresholds ?? [],
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    if (input.credential) await this.upsertCredential(row.id, input.credential);
    return this.getById(row.id);
  }

  async update(id: string, input: UpdateInfraTargetInput): Promise<InfraTarget> {
    const current = await this.rowById(id);
    const patch: Partial<typeof infraTargets.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.os !== undefined) patch.os = input.os;
    if (input.capabilities !== undefined) patch.capabilities = input.capabilities;
    // Keep the derived `kind` shadow in sync when os/capabilities change.
    if (input.os !== undefined || input.capabilities !== undefined) {
      const os = (input.os ?? current.os) as InfraOs;
      const caps = input.capabilities ?? (current.capabilities as InfraCapability[]);
      patch.kind = deriveKind(os, caps);
    }
    if (input.host !== undefined) patch.host = input.host.trim();
    if (input.enabled !== undefined) {
      patch.enabled = input.enabled;
      // Switching monitoring back on must not wait out an interval measured from a poll made before it was off,
      // and the old reading says nothing about the host now.
      if (input.enabled && !current.enabled) {
        patch.lastPolledAt = null;
        patch.status = "unknown";
      }
    }
    if (input.intervalSec !== undefined) patch.intervalSec = input.intervalSec;
    if (input.options !== undefined) patch.options = input.options;
    if (input.thresholds !== undefined) patch.thresholds = input.thresholds;
    await this.db.update(infraTargets).set(patch).where(eq(infraTargets.id, id));
    if (input.credential) await this.upsertCredential(id, input.credential);
    return this.getById(id);
  }

  async delete(id: string): Promise<{ ok: true }> {
    const [row] = await this.db.delete(infraTargets).where(eq(infraTargets.id, id)).returning();
    if (!row) throw new NotFoundException("Infrastructure target not found");
    return { ok: true };
  }

  // ---- credentials ----

  /**
   * Upsert a credential. Blank/omitted secret fields on an existing credential
   * are left unchanged (mirrors the settings `secret` convention), so the UI
   * never has to round-trip the stored ciphertext.
   */
  private async upsertCredential(
    targetId: string,
    input: NonNullable<CreateInfraTargetInput["credential"]>,
  ): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(infraTargetCredentials)
      .where(eq(infraTargetCredentials.targetId, targetId))
      .limit(1);

    const secretEnc =
      input.secret && input.secret.length > 0
        ? encryptSecret(input.secret)
        : existing?.secretEnc ?? null;
    const extraEnc =
      input.extra && input.extra.length > 0
        ? encryptSecret(input.extra)
        : existing?.extraEnc ?? null;
    const caCert = input.caCert !== undefined ? input.caCert || null : existing?.caCert ?? null;

    if (existing) {
      await this.db
        .update(infraTargetCredentials)
        .set({
          authType: input.authType,
          username: input.username ?? existing.username,
          secretEnc,
          extraEnc,
          caCert,
          updatedAt: new Date(),
        })
        .where(eq(infraTargetCredentials.targetId, targetId));
    } else {
      await this.db.insert(infraTargetCredentials).values({
        targetId,
        authType: input.authType,
        username: input.username ?? null,
        secretEnc,
        extraEnc,
        caCert,
      });
    }
  }

  /** Decrypted credential for a target (collector + test-connection only). */
  async getCredential(targetId: string): Promise<DecryptedCredential | null> {
    const [row] = await this.db
      .select()
      .from(infraTargetCredentials)
      .where(eq(infraTargetCredentials.targetId, targetId))
      .limit(1);
    if (!row) return null;
    return {
      authType: row.authType,
      username: row.username,
      secret: row.secretEnc ? decryptStoredSecret(row.secretEnc, "password or key") : null,
      extra: row.extraEnc ? decryptStoredSecret(row.extraEnc, "password or key") : null,
      caCert: row.caCert,
    };
  }

  // ---- reads for the UI ----

  async entities(id: string, entityKind?: InfraEntityKind): Promise<InfraEntity[]> {
    const conds = [eq(infraEntities.targetId, id)];
    if (entityKind) conds.push(eq(infraEntities.entityKind, entityKind));
    const rows = await this.db
      .select()
      .from(infraEntities)
      .where(and(...conds))
      .orderBy(asc(infraEntities.name));
    return rows.map(toEntity);
  }

  async series(
    id: string,
    opts: { from: Date; to: Date; entityKind?: InfraEntityKind; entityId?: string },
  ): Promise<InfraSeriesResponse> {
    const entityKind = opts.entityKind ?? "target";
    const entityId = opts.entityId ?? "";
    const rangeMs = opts.to.getTime() - opts.from.getTime();
    const resolution: "raw" | "5m" | "1h" =
      rangeMs <= 2 * 3_600_000 ? "raw" : rangeMs <= 14 * 86_400_000 ? "5m" : "1h";

    let points: InfraSeriesResponse["points"];
    if (resolution === "raw") {
      const rows = await this.db
        .select()
        .from(infraMetricSamples)
        .where(
          and(
            eq(infraMetricSamples.targetId, id),
            eq(infraMetricSamples.entityKind, entityKind),
            eq(infraMetricSamples.entityId, entityId),
            gte(infraMetricSamples.ts, opts.from),
            lte(infraMetricSamples.ts, opts.to),
          ),
        )
        .orderBy(asc(infraMetricSamples.ts))
        .limit(5000);
      points = rows.map((r) => ({
        ts: r.ts.toISOString(),
        cpuPct: r.cpuPct,
        memPct: r.memPct,
        diskPctMax: r.diskPctMax,
        metrics: (r.metrics as Record<string, unknown>) ?? {},
      }));
    } else {
      const rows = await this.db
        .select()
        .from(infraMetricRollups)
        .where(
          and(
            eq(infraMetricRollups.targetId, id),
            eq(infraMetricRollups.entityKind, entityKind),
            eq(infraMetricRollups.entityId, entityId),
            eq(infraMetricRollups.bucket, resolution),
            gte(infraMetricRollups.ts, opts.from),
            lte(infraMetricRollups.ts, opts.to),
          ),
        )
        .orderBy(asc(infraMetricRollups.ts))
        .limit(5000);
      points = rows.map((r) => {
        const m = (r.metrics as Record<string, { min: number; avg: number; max: number }>) ?? {};
        return {
          ts: r.ts.toISOString(),
          cpuPct: m.cpuPct?.avg ?? null,
          memPct: m.memPct?.avg ?? null,
          diskPctMax: m.diskPctMax?.avg ?? null,
          metrics: m,
        };
      });
    }

    return {
      targetId: id,
      entityKind,
      entityId,
      resolution,
      from: opts.from.toISOString(),
      to: opts.to.toISOString(),
      points: stride(points, MAX_POINTS),
    };
  }

  async summary(): Promise<InfraSummary> {
    const targetRows = await this.db
      .select({ status: infraTargets.status, count: sql<number>`count(*)::int` })
      .from(infraTargets)
      .where(eq(infraTargets.enabled, true))
      .groupBy(infraTargets.status);
    const [disabledRow] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(infraTargets)
      .where(eq(infraTargets.enabled, false));
    const t = { total: 0, up: 0, down: 0, degraded: 0, unknown: 0, disabled: Number(disabledRow?.n ?? 0) };
    for (const r of targetRows) {
      const c = Number(r.count) || 0;
      t.total += c;
      if (r.status === "up" || r.status === "down" || r.status === "degraded" || r.status === "unknown") {
        t[r.status] += c;
      }
    }

    const ents = await this.db
      .select({
        entityKind: infraEntities.entityKind,
        status: infraEntities.status,
        health: infraEntities.health,
        count: sql<number>`count(*)::int`,
      })
      .from(infraEntities)
      .where(eq(infraEntities.present, true))
      .groupBy(infraEntities.entityKind, infraEntities.status, infraEntities.health);
    const containers = { total: 0, running: 0, stopped: 0, unhealthy: 0 };
    const guests = { total: 0, running: 0, stopped: 0 };
    for (const r of ents) {
      const c = Number(r.count) || 0;
      if (r.entityKind === "container") {
        containers.total += c;
        if (r.status === "running") containers.running += c;
        else containers.stopped += c;
        if (r.health === "unhealthy") containers.unhealthy += c;
      } else if (r.entityKind === "guest") {
        guests.total += c;
        if (r.status === "running") guests.running += c;
        else guests.stopped += c;
      }
    }

    // An incident on a switched-off target stays recorded but is not an alert: nothing is polling it to resolve it.
    const [openAlerts] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(monitorIncidents)
      .innerJoin(infraTargets, eq(infraTargets.id, monitorIncidents.targetId))
      .where(and(eq(infraTargets.enabled, true), isNull(monitorIncidents.resolvedAt)));

    // Read straight off each target's last_sample (denormalised, no extra
    // poll) — safe against nulls throughout: a target without the `updates`
    // capability (or never polled) has no metrics.updates path at all, and
    // `->>` on missing/JSON-null yields SQL NULL, which every comparison
    // below quietly excludes rather than erroring.
    const [updRow] = await this.db
      .select({
        hostsWithUpdates: sql<number>`count(*) filter (where (${infraTargets.lastSample}->'metrics'->'updates'->>'count')::int > 0)::int`,
        hostsWithSecurityUpdates: sql<number>`count(*) filter (where (${infraTargets.lastSample}->'metrics'->'updates'->>'securityCount')::int > 0)::int`,
        hostsNeedingReboot: sql<number>`count(*) filter (where (${infraTargets.lastSample}->'metrics'->'updates'->>'rebootRequired')::int = 1)::int`,
      })
      .from(infraTargets)
      .where(eq(infraTargets.enabled, true));

    return {
      targets: t,
      containers,
      guests,
      openAlerts: Number(openAlerts?.n ?? 0),
      updates: {
        hostsWithUpdates: Number(updRow?.hostsWithUpdates ?? 0),
        hostsWithSecurityUpdates: Number(updRow?.hostsWithSecurityUpdates ?? 0),
        hostsNeedingReboot: Number(updRow?.hostsNeedingReboot ?? 0),
      },
    };
  }

  /** Open infra incidents across all targets (for the overview alert list). */
  async openIncidents() {
    const rows = await this.db
      .select({ incident: monitorIncidents })
      .from(monitorIncidents)
      .innerJoin(infraTargets, eq(infraTargets.id, monitorIncidents.targetId))
      .where(and(eq(infraTargets.enabled, true), isNull(monitorIncidents.resolvedAt)))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(100);
    return rows.map((r) => r.incident);
  }

  async incidentsFor(id: string) {
    return this.db
      .select()
      .from(monitorIncidents)
      .where(eq(monitorIncidents.targetId, id))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(50);
  }

  // ---- notification recipients (group-based) ----

  /**
   * User IDs that should receive monitoring notifications: members of the admin
   * group (all permissions) or of any group granted the `monitoring` module
   * (its `user` tier already grants monitors:read:any). Resolved fresh per event
   * so group changes take effect without a restart.
   */
  async monitoringRecipientIds(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(groupMemberships, eq(groupMemberships.userId, users.id))
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .leftJoin(
        groupModuleAccess,
        and(
          eq(groupModuleAccess.groupId, groups.id),
          eq(groupModuleAccess.moduleKey, "monitoring"),
        ),
      )
      .where(
        and(
          eq(users.isActive, true),
          isNull(users.deletedAt),
          or(eq(groups.name, "admin"), sql`${groupModuleAccess.groupId} is not null`),
        ),
      );
    return rows.map((r) => r.id);
  }
}

/**
 * Derive the legacy `kind` shadow from the live os + capabilities model, so the
 * NOT-NULL `kind` column stays meaningful for anything still reading it.
 */
function deriveKind(os: InfraOs, capabilities: readonly string[]): string {
  if (capabilities.includes("hypervisor")) return "proxmox";
  if (capabilities.includes("docker")) return "docker_host";
  return os === "linux" ? "linux_ssh" : `${os}_ssh`;
}

/**
 * Inverse of deriveKind for rows created before the os/capabilities columns
 * existed: their `capabilities` is empty, so map the legacy `kind` back to a
 * capability set. New rows always persist capabilities, so this only ever fires
 * for pre-migration rows. See migration 0032.
 */
function capabilitiesFromKind(kind: string): InfraCapability[] {
  if (kind === "proxmox") return ["hypervisor"];
  if (kind === "docker_host") return ["cpu", "memory", "disk", "load", "docker"];
  if (kind === "linux_ssh") return ["cpu", "memory", "disk", "load"];
  return ["cpu", "memory", "disk"];
}

function toTarget(row: typeof infraTargets.$inferSelect, authType: string | null): InfraTarget {
  const storedCaps = (row.capabilities as InfraCapability[]) ?? [];
  const capabilities = storedCaps.length > 0 ? storedCaps : capabilitiesFromKind(row.kind);
  return {
    id: row.id,
    name: row.name,
    os: (row.os as InfraOs) ?? "linux",
    capabilities,
    host: row.host,
    enabled: row.enabled,
    intervalSec: row.intervalSec,
    options: (row.options as Record<string, unknown>) ?? {},
    thresholds: (row.thresholds as InfraTarget["thresholds"]) ?? [],
    status: row.status as InfraStatus,
    lastPolledAt: row.lastPolledAt ? row.lastPolledAt.toISOString() : null,
    lastError: row.lastError ?? null,
    lastSample: (row.lastSample as Record<string, unknown> | null) ?? null,
    hasCredential: authType !== null,
    authType: (authType as InfraAuthType | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEntity(row: typeof infraEntities.$inferSelect): InfraEntity {
  return {
    id: row.id,
    targetId: row.targetId,
    entityKind: row.entityKind as InfraEntityKind,
    externalId: row.externalId,
    name: row.name,
    groupKey: row.groupKey ?? null,
    status: row.status,
    health: row.health ?? null,
    state: (row.state as Record<string, unknown>) ?? {},
    present: row.present,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

/** Evenly thin an ordered point array down to at most `max` points. */
function stride<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: T[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]!);
  // Always keep the last point so the chart ends at "now".
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
