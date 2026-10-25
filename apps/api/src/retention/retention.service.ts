import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, inArray, isNotNull, lt, ne, or, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { DB, type Db } from "../db/db.module";
import {
  activityEvents,
  authTokens,
  backupOperations,
  ciscoDriftEvents,
  infraUpdateRuns,
  monitorIncidents,
  notifications,
} from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { deleteInBatches } from "./batched-delete";

const EVERY_MS = 6 * 60 * 60_000;
const DAY_MS = 86_400_000;
/** Spent or expired invite/reset links are kept this long (support questions: "my link did not work"), then removed. */
export const AUTH_TOKEN_KEEP_DAYS = 30;
/** Finished backup operations (the progress rows behind Admin > Backups) are kept this long. */
export const BACKUP_OPERATION_KEEP_DAYS = 180;

export interface RetentionResult {
  notifications: number;
  activity: number;
  incidents: number;
  drift: number;
  updateRuns: number;
  authTokens: number;
  backupOperations: number;
}

/**
 * Age-based clean-up of the tables that only ever grow: the notification centre, the activity feed, finished monitoring
 * history (resolved incidents and switch drift, host update runs) and spent sign-in links and backup operations. (The
 * audit log prunes itself in `AuditService`, the infra metrics in `InfraCollector`, mail and bus tables in their stores.)
 * Each window that people care about is a setting (0 keeps everything); runtime state has a fixed window. Runs as one
 * cluster job, in batches. Only FINISHED rows are ever removed: an open incident or a running operation is never old.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "retention-prune", everyMs: EVERY_MS, initialDelayMs: 5 * 60_000, run: async () => void (await this.pruneOnce()) });
  }

  private async days(key: string): Promise<number> {
    const raw = await this.settings.get(key);
    return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  }

  /** Delete rows of `table` matching `where`, by primary key in batches. */
  private prune(table: PgTable, id: PgColumn, where: SQL): Promise<number> {
    return deleteInBatches(async (limit) => {
      const gone = await this.db
        .delete(table)
        .where(inArray(id, this.db.select({ id }).from(table).where(where).limit(limit)))
        .returning({ id });
      return gone.length;
    });
  }

  async pruneOnce(now: Date = new Date()): Promise<RetentionResult> {
    const out: RetentionResult = { notifications: 0, activity: 0, incidents: 0, drift: 0, updateRuns: 0, authTokens: 0, backupOperations: 0 };
    const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
    try {
      const nDays = await this.days("notifications.retention_days");
      if (nDays > 0) out.notifications = await this.prune(notifications, notifications.id, lt(notifications.createdAt, before(nDays)));
      const aDays = await this.days("activity.retention_days");
      if (aDays > 0) out.activity = await this.prune(activityEvents, activityEvents.id, lt(activityEvents.ts, before(aDays)));

      const hDays = await this.days("monitoring.history_retention_days");
      if (hDays > 0) {
        const cutoff = before(hDays);
        out.incidents = await this.prune(
          monitorIncidents,
          monitorIncidents.id,
          and(isNotNull(monitorIncidents.resolvedAt), lt(monitorIncidents.resolvedAt, cutoff))!,
        );
        out.drift = await this.prune(
          ciscoDriftEvents,
          ciscoDriftEvents.id,
          and(isNotNull(ciscoDriftEvents.resolvedAt), lt(ciscoDriftEvents.resolvedAt, cutoff))!,
        );
        out.updateRuns = await this.prune(
          infraUpdateRuns,
          infraUpdateRuns.id,
          and(ne(infraUpdateRuns.status, "running"), isNotNull(infraUpdateRuns.finishedAt), lt(infraUpdateRuns.finishedAt, cutoff))!,
        );
      }

      const tokenCutoff = before(AUTH_TOKEN_KEEP_DAYS);
      out.authTokens = await this.prune(
        authTokens,
        authTokens.id,
        or(lt(authTokens.expiresAt, tokenCutoff), and(isNotNull(authTokens.usedAt), lt(authTokens.usedAt, tokenCutoff)))!,
      );
      out.backupOperations = await this.prune(
        backupOperations,
        backupOperations.id,
        and(ne(backupOperations.status, "running"), isNotNull(backupOperations.finishedAt), lt(backupOperations.finishedAt, before(BACKUP_OPERATION_KEEP_DAYS)))!,
      );

      const removed = Object.entries(out).filter(([, n]) => n > 0);
      if (removed.length > 0) this.logger.log(`retention: removed ${removed.map(([k, n]) => `${n} ${k}`).join(", ")}`);
    } catch (err) {
      this.logger.warn(`retention prune failed: ${(err as Error).message}`);
    }
    return out;
  }
}
