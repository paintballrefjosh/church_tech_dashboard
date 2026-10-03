import { Injectable, Inject, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { monitors, monitorChecks, monitorIncidents } from "../db/schema";
import type { CreateMonitorInput, UpdateMonitorInput } from "@church/shared";

@Injectable()
export class MonitorsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list() {
    return this.db.select().from(monitors).orderBy(asc(monitors.name));
  }

  async getById(id: string) {
    const [row] = await this.db.select().from(monitors).where(eq(monitors.id, id)).limit(1);
    if (!row) throw new NotFoundException("Monitor not found");
    return row;
  }

  async create(input: CreateMonitorInput) {
    const [row] = await this.db
      .insert(monitors)
      .values({
        name: input.name,
        kind: input.kind,
        target: input.target,
        intervalSec: input.intervalSec,
        failThreshold: input.failThreshold,
        recoverThreshold: input.recoverThreshold,
        options: input.options,
        enabled: input.enabled,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(id: string, input: UpdateMonitorInput) {
    await this.getById(id);
    const patch: Partial<typeof monitors.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) patch.name = input.name;
    if (input.kind !== undefined) patch.kind = input.kind;
    if (input.target !== undefined) patch.target = input.target;
    if (input.intervalSec !== undefined) patch.intervalSec = input.intervalSec;
    if (input.failThreshold !== undefined) patch.failThreshold = input.failThreshold;
    if (input.recoverThreshold !== undefined) patch.recoverThreshold = input.recoverThreshold;
    if (input.options !== undefined) patch.options = input.options;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    const [row] = await this.db
      .update(monitors)
      .set(patch)
      .where(eq(monitors.id, id))
      .returning();
    if (!row) throw new NotFoundException("Monitor not found");
    return row;
  }

  async delete(id: string) {
    await this.getById(id);
    // Drain the high-volume child table in bounded batches BEFORE deleting the
    // parent. Relying on the ON DELETE CASCADE alone removes every
    // monitor_checks row (~45k per monitor at the default 60s interval / 30d
    // retention) in one long-held transaction that contends with the prober's
    // continuous inserts into the same table — a single such delete was
    // observed taking ~3.5 min, hanging the request and appearing to freeze the
    // app. Batching keeps each transaction small and releases locks between
    // batches so concurrent inserts get through. The subquery form (vs a bare
    // DELETE ... LIMIT) stays portable and uses monitor_checks_monitor_ts_idx.
    const BATCH = 5000;
    for (;;) {
      const res = await this.db.execute(sql`
        delete from ${monitorChecks}
        where ${monitorChecks.id} in (
          select ${monitorChecks.id} from ${monitorChecks}
          where ${monitorChecks.monitorId} = ${id}
          limit ${BATCH}
        )
      `);
      if ((res.rowCount ?? 0) < BATCH) break;
    }
    // Incidents are low-volume; the parent's cascade handles them cheaply.
    const [row] = await this.db.delete(monitors).where(eq(monitors.id, id)).returning();
    return row;
  }

  /** Most recent N checks for sparkline / detail view. */
  history(id: string, limit = 100) {
    return this.db
      .select()
      .from(monitorChecks)
      .where(eq(monitorChecks.monitorId, id))
      .orderBy(desc(monitorChecks.ts))
      .limit(limit);
  }

  incidents(id: string, limit = 50) {
    return this.db
      .select()
      .from(monitorIncidents)
      .where(eq(monitorIncidents.monitorId, id))
      .orderBy(desc(monitorIncidents.startedAt))
      .limit(limit);
  }

  /** Open incidents across all monitors — used for the dashboard tile. */
  openIncidents() {
    return this.db
      .select()
      .from(monitorIncidents)
      .where(isNull(monitorIncidents.resolvedAt))
      .orderBy(desc(monitorIncidents.startedAt));
  }

  /**
   * Aggregate counts the dashboard tile cares about. Single round-trip via a
   * CASE expression so the tile renders without three separate queries.
   */
  async summary() {
    const [row] = await this.db
      .select({
        total: sql<string | number>`count(*)`,
        up: sql<string | number>`count(*) filter (where ${monitors.status} = 'up')`,
        down: sql<string | number>`count(*) filter (where ${monitors.status} = 'down')`,
        unknown: sql<string | number>`count(*) filter (where ${monitors.status} = 'unknown')`,
      })
      .from(monitors)
      .where(eq(monitors.enabled, true));
    // CockroachDB returns count() as a string by default; coerce here so the
    // wire shape is stable regardless of dialect.
    const toNum = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));
    return {
      total: toNum(row?.total),
      up: toNum(row?.up),
      down: toNum(row?.down),
      unknown: toNum(row?.unknown),
    };
  }

  /** Prune check rows older than `keepDays` to keep the table from growing forever. */
  async pruneOlderThan(keepDays: number) {
    const cutoff = new Date(Date.now() - keepDays * 86_400_000);
    await this.db
      .delete(monitorChecks)
      .where(and(lt(monitorChecks.ts, cutoff), gte(monitorChecks.ts, new Date(0))));
  }
}
