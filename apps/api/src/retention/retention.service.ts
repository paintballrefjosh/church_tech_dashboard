import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { inArray, lt } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { activityEvents, notifications } from "../db/schema";
import { SettingsService } from "../settings/settings.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { deleteInBatches } from "./batched-delete";

const EVERY_MS = 6 * 60 * 60_000;

/**
 * Age-based clean-up of the tables that only ever grow: the notification centre and the activity feed. (The audit
 * log prunes itself in `AuditService`, the infra metrics in `InfraCollector`, mail and bus tables in their stores.)
 * Each window is a setting; 0 keeps everything. Runs as one cluster job, in batches.
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

  async pruneOnce(now: Date = new Date()): Promise<{ notifications: number; activity: number }> {
    const out = { notifications: 0, activity: 0 };
    try {
      const nDays = await this.days("notifications.retention_days");
      if (nDays > 0) {
        const cutoff = new Date(now.getTime() - nDays * 86_400_000);
        out.notifications = await deleteInBatches(async (limit) => {
          const gone = await this.db
            .delete(notifications)
            .where(inArray(notifications.id, this.db.select({ id: notifications.id }).from(notifications).where(lt(notifications.createdAt, cutoff)).limit(limit)))
            .returning({ id: notifications.id });
          return gone.length;
        });
      }
      const aDays = await this.days("activity.retention_days");
      if (aDays > 0) {
        const cutoff = new Date(now.getTime() - aDays * 86_400_000);
        out.activity = await deleteInBatches(async (limit) => {
          const gone = await this.db
            .delete(activityEvents)
            .where(inArray(activityEvents.id, this.db.select({ id: activityEvents.id }).from(activityEvents).where(lt(activityEvents.ts, cutoff)).limit(limit)))
            .returning({ id: activityEvents.id });
          return gone.length;
        });
      }
      if (out.notifications || out.activity) {
        this.logger.log(`retention: removed ${out.notifications} notifications and ${out.activity} activity events`);
      }
    } catch (err) {
      this.logger.warn(`retention prune failed: ${(err as Error).message}`);
    }
    return out;
  }
}
