import { Injectable, Inject, Logger, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { desc, eq, and, lt, gte, getTableColumns, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { auditLog, apiTokens } from "../db/schema";
import { SettingsService } from "../settings/settings.service";

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
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Schedule a daily prune of audit rows older than the configured retention
   * window. Runs in-process; in a multi-replica deploy this would race
   * harmlessly across replicas (deletes are idempotent). Skips when
   * audit.retention_days is 0.
   */
  onModuleInit(): void {
    // Stagger first run by 60s so concurrent replicas don't all prune at the
    // same instant on cold start.
    setTimeout(() => void this.pruneOnce(), 60_000);
    // Then re-run every 24 hours. We don't bother locking to wall-clock 02:00
    // — uniform-jitter is fine for an internal IT tool.
    this.pruneTimer = setInterval(() => void this.pruneOnce(), 24 * 60 * 60 * 1000);
  }
  onModuleDestroy(): void {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
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
      before: (entry.before ?? null) as never,
      after: (entry.after ?? null) as never,
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
