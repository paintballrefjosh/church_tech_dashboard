import { Injectable, Inject, Logger, type OnModuleInit } from "@nestjs/common";
import { desc, eq, and, lt, gt, gte, asc, sql, getTableColumns, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { auditLog, apiTokens } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { JobStateService } from "../cluster/job-state.service";
import { needsScrub, scrubSnapshot } from "./audit-scrub";

const BACKFILL_JOB = "audit-scrub-backfill";
const BACKFILL_BATCH = 500;

export interface AuditWrite {
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  /** The API token the request authenticated with, if any. */
  apiTokenId?: string | null;
}

@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly jobs: ClusterJobs,
    private readonly state: JobStateService,
  ) {}

  /**
   * Schedule a daily prune of audit rows older than the configured retention
   * window. Runs as a cluster job, so one node at a time. Skips when
   * audit.retention_days is 0.
   */
  onModuleInit(): void {
    // First run 60s after boot, then every 24 hours. We don't bother locking to
    // wall-clock 02:00 — uniform-jitter is fine for an internal IT tool.
    this.jobs.register({ name: "audit-prune", everyMs: 24 * 60 * 60 * 1000, initialDelayMs: 60_000, run: () => this.pruneOnce() });
    // Rows written before snapshots were scrubbed may still hold a secret. Runs once per database.
    this.jobs.register({ name: BACKFILL_JOB, everyMs: 6 * 60 * 60 * 1000, initialDelayMs: 90_000, run: async () => void (await this.backfillOnce()) });
  }

  /**
   * Rewrite stored snapshots that hold a credential-looking key (a monitor's Authorization header, from before
   * `write` scrubbed). Pages through the table by id and changes only rows the scrub would change, so it is
   * safe to repeat; a marker in job_state stops later runs from scanning again.
   */
  async backfillOnce(): Promise<number> {
    try {
      if (await this.state.get(BACKFILL_JOB, "done")) return 0;
      let last: string | null = null;
      let changed = 0;
      for (;;) {
        const rows: { id: string; before: unknown; after: unknown }[] = await this.db
          .select({ id: auditLog.id, before: auditLog.before, after: auditLog.after })
          .from(auditLog)
          .where(
            and(
              last ? gt(auditLog.id, last) : undefined,
              sql`(coalesce(${auditLog.before}::text, '') || coalesce(${auditLog.after}::text, '')) ~* 'pass|secret|token|authorization|bearer|community|private.?key|api.?key|credential|cookie'`,
            ),
          )
          .orderBy(asc(auditLog.id))
          .limit(BACKFILL_BATCH);
        if (rows.length === 0) break;
        for (const r of rows) {
          if (needsScrub(r.before) || needsScrub(r.after)) {
            await this.db
              .update(auditLog)
              .set({ before: scrubSnapshot(r.before) as never, after: scrubSnapshot(r.after) as never })
              .where(eq(auditLog.id, r.id));
            changed++;
          }
        }
        last = rows[rows.length - 1]!.id;
      }
      await this.state.set(BACKFILL_JOB, "done", { at: new Date().toISOString(), changed });
      if (changed > 0) this.logger.log(`audit scrub: hid secrets in ${changed} stored snapshots`);
      return changed;
    } catch (err) {
      this.logger.warn(`audit scrub backfill failed: ${(err as Error).message}`);
      return 0;
    }
  }

  private async pruneOnce(): Promise<void> {
    try {
      const raw = await this.settings.get("audit.retention_days");
      const days = typeof raw === "number" && raw > 0 ? raw : 0;
      if (days <= 0) return;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const deleted = await this.db
        .delete(auditLog)
        .where(lt(auditLog.ts, cutoff))
        .returning({ id: auditLog.id });
      if (deleted.length > 0) {
        this.logger.log(`audit prune: removed ${deleted.length} rows older than ${days}d`);
      }
    } catch (err) {
      this.logger.warn(`audit prune failed: ${(err as Error).message}`);
    }
  }

  async write(entry: AuditWrite): Promise<void> {
    await this.db.insert(auditLog).values({
      actorUserId: entry.actorUserId ?? null,
      actorEmail: entry.actorEmail ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      // Whatever a route answered with is the snapshot, and not every route strips its secrets first.
      before: scrubSnapshot(entry.before ?? null) as never,
      after: scrubSnapshot(entry.after ?? null) as never,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      apiTokenId: entry.apiTokenId ?? null,
    });
  }

  async list(opts: {
    limit?: number;
    cursor?: Date;
    actorUserId?: string;
    resourceType?: string;
    action?: string;
    from?: Date;
    to?: Date;
  }) {
    const conditions: SQL[] = [];
    if (opts.cursor) conditions.push(lt(auditLog.ts, opts.cursor));
    if (opts.actorUserId) conditions.push(eq(auditLog.actorUserId, opts.actorUserId));
    if (opts.resourceType) conditions.push(eq(auditLog.resourceType, opts.resourceType));
    if (opts.action) conditions.push(eq(auditLog.action, opts.action));
    if (opts.from) conditions.push(gte(auditLog.ts, opts.from));
    if (opts.to) conditions.push(lt(auditLog.ts, opts.to));

    const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);

    // apiTokenName lets the audit page say "via token <name>".
    const rows = await this.db
      .select({ ...getTableColumns(auditLog), apiTokenName: apiTokens.name })
      .from(auditLog)
      .leftJoin(apiTokens, eq(apiTokens.id, auditLog.apiTokenId))
      .where(where)
      .orderBy(desc(auditLog.ts))
      .limit(opts.limit ?? 50);
    return rows;
  }
}
