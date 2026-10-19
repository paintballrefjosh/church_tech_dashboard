import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { desc, eq, sql } from "drizzle-orm";
import { backupsToVerify } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { backups } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { BackupService, type Tracker } from "./backup.service";
import { OBJECT_STORE, type ObjectStore } from "./object-store";
import { verifyStoredArchive } from "./backup-verify";

type BackupRow = typeof backups.$inferSelect;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Re-reads stored backups to prove they are whole: the checksum recorded when each was made, a clean decompression, every row
 * and file as the summary says, and rows a restore could use (see backup-verify.ts). Nothing is read from or written to the
 * live data; the outcome goes on the backup's own row, a failure is announced to the administrators once, and the Security
 * overview judges it. This is not a restore: `tests/cluster/verify-restore.sh` restores a real backup on a throwaway cluster.
 */
@Injectable()
export class VerifyService implements OnModuleInit {
  private readonly logger = new Logger(VerifyService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly backupsService: BackupService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "backup-verify",
      everyMs: 10 * 60_000,
      schedule: "fixed-delay",
      initialDelayMs: 3 * 60_000,
      run: () => this.tick(),
    });
  }

  /** Every ten minutes, on the node leading the job: check what is due. */
  async tick(): Promise<void> {
    const recent = await this.db
      .select({
        id: backups.id,
        status: backups.status,
        createdAt: backups.createdAt,
        finishedAt: backups.finishedAt,
        verifiedAt: backups.verifiedAt,
        verifyError: backups.verifyError,
        verifyTriedAt: backups.verifyTriedAt,
      })
      .from(backups)
      .where(eq(backups.status, "ready"))
      .orderBy(desc(backups.createdAt))
      .limit(10);
    const due = backupsToVerify(
      recent.map((r) => ({
        id: r.id,
        status: r.status,
        createdAt: r.createdAt.getTime(),
        finishedAt: r.finishedAt?.getTime() ?? null,
        verifiedAt: r.verifiedAt?.getTime() ?? null,
        verifyError: r.verifyError,
        verifyTriedAt: r.verifyTriedAt?.getTime() ?? null,
      })),
      Date.now(),
    );
    if (due.length === 0) return;
    const op = await this.backupsService.beginOperation("verify", null, null, "Checking stored backups");
    if (!op) return; // another backup operation is running; the next tick tries again
    try {
      await this.run(op.tracker, due);
    } finally {
      await op.mutex.release();
    }
  }

  /** Check one backup now, in the background. */
  async startCheck(user: { id: string }, backupId: string): Promise<{ operationId: string }> {
    const [row] = await this.db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
    if (!row) throw new NotFoundException("Backup not found");
    if (row.status !== "ready") throw new BadRequestException(row.status === "running" ? "That backup is still being made." : "That backup failed and has nothing to check.");
    const op = await this.backupsService.beginOperation("verify", backupId, user.id, "Checking the stored backup");
    if (!op) throw new ConflictException("Another backup, import, comparison or restore is running. Wait for it to finish.");
    this.backupsService.background("backup check", async () => {
      try {
        await this.run(op.tracker, [backupId]);
      } finally {
        await op.mutex.release();
      }
    });
    return { operationId: op.tracker.id };
  }

  private async run(tracker: Tracker, ids: string[]): Promise<void> {
    const results: Array<{ id: string; name: string; ok: boolean; problems: string[]; rows: number; files: number }> = [];
    try {
      for (const [i, id] of ids.entries()) {
        const [row] = await this.db.select().from(backups).where(eq(backups.id, id)).limit(1);
        if (!row || row.status !== "ready") continue;
        await tracker.phase(`Checking ${row.name}`, { label: row.name, done: i, total: ids.length });
        await this.backupsService.setOperationBackup(tracker.id, row.id);
        results.push(await this.checkOne(row));
      }
      const failed = results.filter((r) => !r.ok);
      if (results.length > 0 && failed.length === results.length) await tracker.fail(failed.map((r) => `${r.name}: ${r.problems[0] ?? "failed"}`).join(" | "));
      else await tracker.succeed({ checked: results.length, failed: failed.length, results });
    } catch (err) {
      await tracker.fail(message(err));
    }
  }

  private async checkOne(row: BackupRow): Promise<{ id: string; name: string; ok: boolean; problems: string[]; rows: number; files: number }> {
    const report = await verifyStoredArchive(() => this.store.get(row.s3Key), {
      sha256: row.sha256,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
    });
    if (report.ok) {
      await this.db.update(backups).set({ verifiedAt: sql`now()`, verifyError: null, verifyTriedAt: sql`now()` }).where(eq(backups.id, row.id));
    } else {
      const text = report.problems.join(" | ").slice(0, 2000);
      await this.db.update(backups).set({ verifyError: text, verifyTriedAt: sql`now()` }).where(eq(backups.id, row.id));
      // Tell the administrators once; a retry that fails again says nothing new.
      if (!row.verifyError) {
        await this.backupsService.notifyAdmins(`A backup failed its check: ${row.name}`, report.problems[0] ?? "It could not be read back.", "/admin/backups");
      }
      this.logger.warn(`backup ${row.id} failed its check: ${report.problems[0]}`);
    }
    return { id: row.id, name: row.name, ok: report.ok, problems: report.problems, rows: report.rows, files: report.files };
  }
}
