import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  DEFAULT_GROUPS,
  type BackupCreate,
  type BackupDiffReport,
  type BackupOperation,
  type BackupOperationKind,
  type BackupProgress,
  type BackupRestoreResult,
  type BackupRestoreSection,
  type BackupSchedule,
  type BackupScheduleInput,
  type BackupScheduleUpdate,
  type BackupStorageInfo,
  type BackupSummary,
  type RestoreRequest,
} from "@church/shared";
import { RESTORE_LEASE_NAME } from "@church/shared/db";
import { DB, type Db } from "../db/db.module";
import { backupOperations, backupSchedules, backups, groupMemberships, groups, users } from "../db/schema";
import { LeaseService, type Mutex } from "../cluster/lease.service";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NodeService } from "../cluster/node.service";
import { RestoreGate } from "../cluster/restore-gate";
import { SettingsService } from "../settings/settings.service";
import { AuthService } from "../auth/auth.service";
import { SearchService } from "../search/search.service";
import { NotificationsService } from "../notifications/notifications.service";
import { gunzipped, readArchive } from "./archive";
import { storeBackup } from "./backup-writer";
import { computeDiff, type DiffContext, type DiffOutput } from "./backup-diff";
import { restoreSections, tablesInSections } from "./table-registry";
import { applyRestore } from "./backup-restore";
import { inspectArchive } from "./backup-inspect";
import { BACKUP_PREFIX, FILES_PREFIX, OBJECT_STORE, type ObjectStore } from "./object-store";
import { nextRunAfter } from "./schedule";

/** A backup operation that has not reported for this long belongs to a node that died. */
const STALE_OPERATION_MINUTES = 3;
/** The lease that allows one backup, comparison, import or restore at a time, renewed while it runs. */
const OPERATION_LEASE = "backup";
const OPERATION_LEASE_TTL_SEC = 90;
/**
 * The write gate's lease. Renewed every third of this while the restore runs, so it holds as long as the
 * node is alive, and is what keeps changes blocked after a node dies mid-restore: kept short so that is brief.
 */
const GATE_LEASE_TTL_SEC = 40;
/** Safety backups kept (the newest; older ones are deleted so they do not pile up). */
const KEEP_PRE_RESTORE = 5;
const DOWNLOAD_LINK_TTL_MS = 5 * 60 * 1000;
/** How long the restore gate's answer may be cached on a node (see RestoreGate): waited out after it opens. */
const GATE_CACHE_SETTLE_MS = 1200;

type BackupRow = typeof backups.$inferSelect;
type OperationRow = typeof backupOperations.$inferSelect;
type ScheduleRow = typeof backupSchedules.$inferSelect;

export function secretFingerprint(): string {
  const secret = process.env.AUTH_SECRET ?? "";
  return createHash("sha256").update(`church-dashboard/backup-fingerprint/v1:${secret}`).digest("hex").slice(0, 16);
}

/** Writes an operation's progress to its row, at most about once a second, with a heartbeat while it is quiet. */
class Tracker {
  private last = 0;
  private timer: NodeJS.Timeout | null = null;
  private current: { phase: string; progress: BackupProgress | null } = { phase: "", progress: null };

  constructor(
    private readonly db: Db,
    readonly id: string,
  ) {
    this.timer = setInterval(() => void this.flush(), 15_000);
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    this.last = Date.now();
    await this.db
      .update(backupOperations)
      .set({ phase: this.current.phase, progress: this.current.progress, updatedAt: sql`now()` })
      .where(and(eq(backupOperations.id, this.id), eq(backupOperations.status, "running")))
      .catch(() => undefined);
  }

  async phase(phase: string, progress: BackupProgress | null = null): Promise<void> {
    this.current = { phase, progress };
    await this.flush();
  }

  progress = (p: BackupProgress): void | Promise<void> => {
    this.current = { phase: this.current.phase, progress: p };
    if (Date.now() - this.last >= 1000) return this.flush();
    return undefined;
  };

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async succeed(result: unknown): Promise<void> {
    this.stop();
    await this.db
      .update(backupOperations)
      .set({ status: "succeeded", result: result ?? null, progress: null, phase: "Done", finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(backupOperations.id, this.id));
  }

  async fail(error: string): Promise<void> {
    this.stop();
    await this.db
      .update(backupOperations)
      .set({ status: "failed", error: error.slice(0, 2000), progress: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(backupOperations.id, this.id))
      .catch(() => undefined);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/\s+/g, "-").slice(0, 80) || "backup";
}

@Injectable()
export class BackupService implements OnModuleInit {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
    private readonly leases: LeaseService,
    private readonly jobs: ClusterJobs,
    private readonly node: NodeService,
    private readonly gate: RestoreGate,
    private readonly settings: SettingsService,
    private readonly auth: AuthService,
    private readonly search: SearchService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "backup-scheduler",
      everyMs: 60_000,
      schedule: "fixed-delay",
      initialDelayMs: 30_000,
      run: () => this.tick(),
    });
    this.jobs.register({
      name: "backup-orphan-sweep",
      everyMs: 30 * 60_000,
      schedule: "fixed-delay",
      initialDelayMs: 5 * 60_000,
      run: async () => void (await this.sweepOrphans()),
    });
  }

  /**
   * Remove archives in storage that no `backups` row refers to (left by a delete that failed, or by a
   * node that died between uploading and recording). A row is written before its upload starts, so an
   * archive without one is an orphan; the age check only guards against a row not yet visible.
   */
  async sweepOrphans(): Promise<number> {
    const known = new Set((await this.db.select({ key: backups.s3Key }).from(backups)).map((r) => r.key));
    const objects = await this.store.list(BACKUP_PREFIX);
    const orphans = objects.map((o) => o.key).filter((k) => /^backups\/[0-9a-f-]{36}\.tar\.gz$/.test(k) && !known.has(k));
    if (orphans.length === 0) return 0;
    // Re-read the rows a moment later: an archive being uploaded right now has its row already, but be sure.
    await new Promise((r) => setTimeout(r, 5000));
    const again = new Set((await this.db.select({ key: backups.s3Key }).from(backups)).map((r) => r.key));
    const really = orphans.filter((k) => !again.has(k));
    await this.store.remove(really);
    if (really.length > 0) this.logger.log(`removed ${really.length} backup archive(s) with no record`);
    return really.length;
  }

  // ------------------------------------------------------------------ listing

  private toSummary(r: BackupRow, creator: { id: string; email: string; name: string | null } | null, scheduleName: string | null): BackupSummary {
    const counts = (r.tableCounts ?? {}) as Record<string, number>;
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as BackupSummary["kind"],
      status: r.status as BackupSummary["status"],
      scheduleId: r.scheduleId,
      scheduleName,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      includeFiles: r.includeFiles,
      fileCount: r.fileCount,
      fileBytes: Number(r.fileBytes),
      tableCounts: counts,
      totalRows: Object.values(counts).reduce((n, v) => n + Number(v), 0),
      schemaMigrations: r.schemaMigrations,
      appVersion: r.appVersion,
      createdBy: creator ? { id: creator.id, email: creator.email, displayName: creator.name } : null,
      error: r.error,
    };
  }

  async list(): Promise<BackupSummary[]> {
    const rows = await this.db
      .select({ b: backups, uid: users.id, email: users.email, name: users.name, scheduleName: backupSchedules.name })
      .from(backups)
      .leftJoin(users, eq(backups.createdBy, users.id))
      .leftJoin(backupSchedules, eq(backups.scheduleId, backupSchedules.id))
      .orderBy(desc(backups.createdAt));
    return rows.map((r) => this.toSummary(r.b, r.uid ? { id: r.uid, email: r.email!, name: r.name } : null, r.scheduleName));
  }

  async get(id: string): Promise<BackupSummary> {
    const [r] = await this.db
      .select({ b: backups, uid: users.id, email: users.email, name: users.name, scheduleName: backupSchedules.name })
      .from(backups)
      .leftJoin(users, eq(backups.createdBy, users.id))
      .leftJoin(backupSchedules, eq(backups.scheduleId, backupSchedules.id))
      .where(eq(backups.id, id))
      .limit(1);
    if (!r) throw new NotFoundException("Backup not found");
    return this.toSummary(r.b, r.uid ? { id: r.uid, email: r.email!, name: r.name } : null, r.scheduleName);
  }

  private async row(id: string): Promise<BackupRow> {
    const [r] = await this.db.select().from(backups).where(eq(backups.id, id)).limit(1);
    if (!r) throw new NotFoundException("Backup not found");
    return r;
  }

  private async readyRow(id: string): Promise<BackupRow> {
    const r = await this.row(id);
    if (r.status !== "ready") throw new BadRequestException(r.status === "running" ? "That backup is still being made." : "That backup failed and cannot be used.");
    return r;
  }

  async storage(): Promise<BackupStorageInfo> {
    const rows = await this.db.select({ n: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(${backups.sizeBytes}), 0)` }).from(backups).where(eq(backups.status, "ready"));
    let available = true;
    try {
      await this.store.list(BACKUP_PREFIX);
    } catch {
      available = false;
    }
    return { count: Number(rows[0]?.n ?? 0), totalBytes: Number(rows[0]?.bytes ?? 0), available };
  }

  async rename(id: string, name: string): Promise<BackupSummary> {
    await this.row(id);
    await this.db.update(backups).set({ name }).where(eq(backups.id, id));
    return this.get(id);
  }

  // ------------------------------------------------------------------ operations

  private toOperation(r: OperationRow, withResult: boolean): BackupOperation {
    return {
      id: r.id,
      kind: r.kind as BackupOperationKind,
      status: r.status as BackupOperation["status"],
      backupId: r.backupId,
      phase: r.phase,
      progress: (r.progress as BackupProgress | null) ?? null,
      result: withResult ? (r.result ?? null) : null,
      error: r.error,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
    };
  }

  async operation(id: string): Promise<BackupOperation> {
    const [r] = await this.db.select().from(backupOperations).where(eq(backupOperations.id, id)).limit(1);
    if (!r) throw new NotFoundException("Operation not found");
    return this.toOperation(r, true);
  }

  async operations(limit = 20): Promise<BackupOperation[]> {
    const rows = await this.db.select().from(backupOperations).orderBy(desc(backupOperations.startedAt)).limit(limit);
    return rows.map((r) => this.toOperation(r, false));
  }

  private async startOperation(kind: BackupOperationKind, backupId: string | null, userId: string | null, phase: string): Promise<Tracker> {
    const [row] = await this.db
      .insert(backupOperations)
      .values({ kind, backupId, requestedBy: userId, phase, nodeId: this.node.identity.nodeId })
      .returning({ id: backupOperations.id });
    return new Tracker(this.db, row!.id);
  }

  private async takeOperationLease(): Promise<Mutex> {
    const mutex = await this.leases.acquireMutex(OPERATION_LEASE, OPERATION_LEASE_TTL_SEC);
    if (!mutex) throw new ConflictException("Another backup, import, comparison or restore is running. Wait for it to finish.");
    if (await this.gate.isRestoring()) {
      await mutex.release();
      throw new ConflictException("A restore is running.");
    }
    return mutex;
  }

  /** Run something after the HTTP response, logging what escapes (every path reports through its Tracker). */
  private background(label: string, work: () => Promise<void>): void {
    void work().catch((err: unknown) => this.logger.error(`${label} failed unexpectedly: ${message(err)}`));
  }

  // ------------------------------------------------------------------ making backups

  /**
   * Make a backup and store it. Creates the `backups` row first (so it shows as running), fills it
   * in when done and marks it failed if anything goes wrong.
   */
  private async makeBackup(input: {
    name: string;
    kind: BackupRow["kind"];
    includeFiles: boolean;
    userId: string | null;
    scheduleId?: string | null;
    tracker?: Tracker | null;
    phasePrefix?: string;
  }): Promise<{ backupId: string; row: BackupRow }> {
    const id = randomUUID();
    const key = `${BACKUP_PREFIX}${id}.tar.gz`;
    await this.db.insert(backups).values({
      id,
      name: input.name,
      kind: input.kind,
      status: "running",
      scheduleId: input.scheduleId ?? null,
      createdBy: input.userId,
      s3Key: key,
      includeFiles: input.includeFiles,
      appVersion: process.env.BUILD_ID ?? null,
      secretFingerprint: secretFingerprint(),
      nodeId: this.node.identity.nodeId,
    });
    if (input.tracker) await this.db.update(backupOperations).set({ backupId: id }).where(eq(backupOperations.id, input.tracker.id));
    try {
      const stored = await storeBackup(
        {
          db: this.db,
          store: this.store,
          progress: (p) => input.tracker?.progress({ ...p, label: `${input.phasePrefix ?? ""}${p.label}` }),
        },
        key,
        {
          id,
          name: input.name,
          includeFiles: input.includeFiles,
          createdBy: input.userId,
          appVersion: process.env.BUILD_ID ?? null,
          secretFingerprint: secretFingerprint(),
        },
      );
      await this.db
        .update(backups)
        .set({
          status: "ready",
          finishedAt: sql`now()`,
          sizeBytes: stored.sizeBytes,
          sha256: stored.sha256,
          fileCount: stored.fileCount,
          fileBytes: stored.fileBytes,
          tableCounts: stored.tableCounts,
          schemaMigrations: stored.schemaMigrations,
          error: stored.missingFiles.length > 0 ? `${stored.missingFiles.length} file(s) were already missing from storage and are not included.` : null,
        })
        .where(eq(backups.id, id));
      return { backupId: id, row: await this.row(id) };
    } catch (err) {
      await this.db.update(backups).set({ status: "failed", finishedAt: sql`now()`, error: message(err).slice(0, 2000) }).where(eq(backups.id, id)).catch(() => undefined);
      throw err;
    }
  }

  /** Start a backup now. Returns at once; the operation reports progress. */
  async startBackup(user: { id: string }, input: BackupCreate): Promise<{ backupId: string | null; operationId: string }> {
    const mutex = await this.takeOperationLease();
    const name = input.name ?? `Backup ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    let tracker: Tracker;
    try {
      tracker = await this.startOperation("backup", null, user.id, "Starting");
    } catch (err) {
      await mutex.release();
      throw err;
    }
    this.background("backup", async () => {
      try {
        const { backupId, row } = await this.makeBackup({ name, kind: "manual", includeFiles: input.includeFiles, userId: user.id, tracker });
        await tracker.succeed({ backupId, sizeBytes: row.sizeBytes });
      } catch (err) {
        await tracker.fail(message(err));
      } finally {
        await mutex.release();
      }
    });
    return { backupId: null, operationId: tracker.id };
  }

  // ------------------------------------------------------------------ uploaded backups

  /** Take an uploaded backup file into the store and check it. The upload runs in the request; the checking after it. */
  async importUpload(
    user: { id: string },
    filename: string,
    body: Readable,
    wasTruncated: () => boolean,
  ): Promise<{ backupId: string; operationId: string }> {
    const mutex = await this.takeOperationLease();
    const id = randomUUID();
    const key = `${BACKUP_PREFIX}${id}.tar.gz`;
    const name = filename.replace(/\.(tar\.gz|tgz)$/i, "") || "Uploaded backup";
    let tracker: Tracker | null = null;
    try {
      await this.db.insert(backups).values({
        id,
        name,
        kind: "uploaded",
        status: "running",
        createdBy: user.id,
        s3Key: key,
        nodeId: this.node.identity.nodeId,
      });
      tracker = await this.startOperation("import", id, user.id, "Receiving the file");

      const hash = createHash("sha256");
      let size = 0;
      let first = true;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (first) {
            first = false;
            if (chunk.length < 2 || chunk[0] !== 0x1f || chunk[1] !== 0x8b) {
              cb(new Error("That is not a backup file (backups are .tar.gz files downloaded from this page)."));
              return;
            }
          }
          size += chunk.length;
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      body.pipe(counter);
      // An error on either stream must reach us (not become an unhandled 'error' event, which would
      // take the whole process down) and must not leave the upload waiting for data that never comes.
      const failed = new Promise<never>((_, reject) => {
        counter.once("error", reject);
        body.once("error", reject);
      });
      failed.catch(() => undefined);
      const putting = this.store.put(key, counter, "application/gzip");
      putting.catch(() => undefined);
      try {
        await Promise.race([putting, failed]);
      } catch (err) {
        counter.destroy();
        body.unpipe(counter);
        body.resume();
        throw err;
      }
      if (wasTruncated()) throw new Error("The file is larger than this installation accepts for an upload.");
      if (size === 0) throw new Error("The file is empty.");
      await this.db.update(backups).set({ sizeBytes: size, sha256: hash.digest("hex") }).where(eq(backups.id, id));
    } catch (err) {
      await this.store.remove([key]).catch(() => undefined);
      await this.db.update(backups).set({ status: "failed", finishedAt: sql`now()`, error: message(err).slice(0, 2000) }).where(eq(backups.id, id)).catch(() => undefined);
      await tracker?.fail(message(err));
      await mutex.release();
      throw new BadRequestException(message(err));
    }

    const t = tracker!;
    this.background("import", async () => {
      try {
        await t.phase("Checking the file");
        const info = await inspectArchive(gunzipped(await this.store.get(key)));
        await this.db
          .update(backups)
          .set({
            status: "ready",
            finishedAt: sql`now()`,
            includeFiles: info.manifest.includeFiles,
            fileCount: info.fileCount,
            fileBytes: info.fileBytes,
            tableCounts: info.tableCounts,
            schemaMigrations: info.manifest.schemaMigrations,
            appVersion: info.manifest.appVersion,
            secretFingerprint: info.manifest.secretFingerprint,
            name: name === "Uploaded backup" ? info.manifest.name : name,
          })
          .where(eq(backups.id, id));
        await t.succeed({ backupId: id });
      } catch (err) {
        await this.db.update(backups).set({ status: "failed", finishedAt: sql`now()`, error: message(err).slice(0, 2000) }).where(eq(backups.id, id)).catch(() => undefined);
        await t.fail(message(err));
      } finally {
        await mutex.release();
      }
    });
    return { backupId: id, operationId: t.id };
  }

  // ------------------------------------------------------------------ comparing

  private archiveOf(row: BackupRow): () => AsyncIterable<Buffer> {
    const store = this.store;
    return async function* () {
      yield* gunzipped(await store.get(row.s3Key));
    };
  }

  /** The sections a restore can be limited to, with what is in each. */
  sections(): BackupRestoreSection[] {
    return restoreSections();
  }

  /**
   * The scope a request asks for: null for everything (no sections given, or every one of them: the
   * same as a full rollback, and handled by exactly that code), else the tables and whether the files.
   */
  private scopeFor(sections: string[] | undefined): DiffContext["scope"] {
    if (!sections) return null;
    const all = restoreSections();
    const known = new Set(all.map((s) => s.key));
    const wanted = [...new Set(sections)];
    const unknown = wanted.filter((k) => !known.has(k));
    if (unknown.length > 0) throw new BadRequestException(`Unknown section: ${unknown.join(", ")}.`);
    if (all.every((s) => wanted.includes(s.key))) return null;
    const files = all.filter((s) => s.hasFiles).some((s) => wanted.includes(s.key));
    return { sections: all.filter((s) => wanted.includes(s.key)).map((s) => s.key), tables: tablesInSections(wanted), files };
  }

  private async diff(row: BackupRow, userId: string | null, tracker: Tracker, scope: DiffContext["scope"] = null): Promise<DiffOutput> {
    return computeDiff(
      { db: this.db, store: this.store, progress: tracker.progress },
      {
        backup: { id: row.id, name: row.name, createdAt: row.createdAt.toISOString() },
        archive: this.archiveOf(row),
        secretFingerprint: secretFingerprint(),
        userId,
        scope,
      },
    );
  }

  async startCompare(user: { id: string }, backupId: string, sections?: string[]): Promise<{ operationId: string }> {
    const scope = this.scopeFor(sections);
    const row = await this.readyRow(backupId);
    const mutex = await this.takeOperationLease();
    let tracker: Tracker;
    try {
      tracker = await this.startOperation("compare", backupId, user.id, "Comparing with the current data");
    } catch (err) {
      await mutex.release();
      throw err;
    }
    this.background("compare", async () => {
      try {
        const out = await this.diff(row, user.id, tracker, scope);
        await tracker.succeed(out.report satisfies BackupDiffReport);
      } catch (err) {
        await tracker.fail(message(err));
      } finally {
        await mutex.release();
      }
    });
    return { operationId: tracker.id };
  }

  // ------------------------------------------------------------------ restoring

  async startRestore(user: { id: string }, backupId: string, req: RestoreRequest): Promise<{ operationId: string }> {
    const scope = this.scopeFor(req.sections);
    const row = await this.readyRow(backupId);
    const mutex = await this.takeOperationLease();
    let tracker: Tracker;
    try {
      tracker = await this.startOperation("restore", backupId, user.id, "Starting the restore");
    } catch (err) {
      await mutex.release();
      throw err;
    }
    this.background("restore", async () => {
      let gateLease: Mutex | null = null;
      // Writes are allowed again before the operation says it is over, so whoever sees "done" can
      // write at once. The gate's answer is cached for a second on every node: wait that out.
      const openGate = async () => {
        if (gateLease) {
          await gateLease.release();
          gateLease = null;
          this.gate.reset();
          await new Promise((r) => setTimeout(r, GATE_CACHE_SETTLE_MS));
        }
      };
      try {
        const result = await this.performRestore(row, user.id, req, tracker, (m) => (gateLease = m), scope);
        await openGate();
        await tracker.succeed(result);
      } catch (err) {
        this.logger.error(`restore of ${backupId} failed: ${message(err)}`);
        await openGate().catch(() => undefined);
        await tracker.fail(message(err));
      } finally {
        await openGate().catch(() => undefined);
        this.gate.reset();
        await mutex.release();
      }
    });
    return { operationId: tracker.id };
  }

  private async performRestore(
    row: BackupRow,
    userId: string,
    req: RestoreRequest,
    tracker: Tracker,
    holdGate: (m: Mutex) => void,
    scope: DiffContext["scope"] = null,
  ): Promise<BackupRestoreResult> {
    // 1. Cheap checks on the backup's first entry, before anything is paused.
    await tracker.phase("Checking the backup");
    for await (const event of readArchive(this.archiveOf(row)(), { parseRows: false })) {
      if (event.type === "manifest") {
        if (event.manifest.secretFingerprint !== secretFingerprint() && !req.acceptSecretMismatch) {
          throw new Error(
            "This backup was made with a different AUTH_SECRET, so saved passwords and tokens in it cannot be read here. Tick \"Go ahead anyway\" to restore it and enter them again.",
          );
        }
        break;
      }
    }

    // 2. Stop everyone else writing.
    const gateLease = await this.leases.acquireMutex(RESTORE_LEASE_NAME.replace(/^mutex:/, ""), GATE_LEASE_TTL_SEC);
    if (!gateLease) throw new ConflictException("A restore is already running.");
    holdGate(gateLease);
    this.gate.reset();
    // Announced once it is true: whoever sees "Pausing changes" can rely on the gate being shut.
    await tracker.phase("Pausing changes");
    // Requests already past the gate on this or another node finish; the gate's cache lapses within a second.
    await new Promise((r) => setTimeout(r, 2500));

    // 3. Work out exactly what will change, and refuse if it cannot work.
    const out = await this.diff(row, userId, tracker, scope);
    await tracker.phase("Comparing with the current data");
    if (!out.report.compatibility.ok) throw new Error(out.report.compatibility.errors.join(" "));

    // 4. A way back.
    let safetyBackupId: string | null = null;
    if (req.safetyBackup) {
      await tracker.phase("Making a safety backup of the current data");
      const safety = await this.makeBackup({
        name: `Before restoring "${row.name}"`,
        kind: "pre_restore",
        includeFiles: true,
        userId,
        phasePrefix: "Safety backup: ",
        tracker,
      });
      // makeBackup pointed the operation at the safety backup; point it back at what is being restored.
      await this.db.update(backupOperations).set({ backupId: row.id }).where(eq(backupOperations.id, tracker.id));
      safetyBackupId = safety.backupId;
    }

    // 5. Files first (adding them is harmless if the database step then fails), then the database.
    const files = await this.restoreFiles(row, out, tracker);
    // If this node stalled long enough for the gate to lapse, others may have been writing: do not touch the data.
    if (gateLease.lost) throw new Error("The write pause lapsed while the restore was preparing (this node stalled). Nothing was changed; try again.");
    await tracker.phase("Restoring the data");
    const counts = await applyRestore({ db: this.db, progress: tracker.progress }, out, { archive: this.archiveOf(row) });

    // 6. After the commit. The data is restored now, so nothing here may turn that into a failure:
    // what goes wrong is reported as a warning.
    await tracker.phase("Cleaning up");
    const warnings = [...out.report.compatibility.warnings];
    if (scope) {
      const titles = restoreSections().filter((sec) => scope.sections.includes(sec.key)).map((sec) => sec.title);
      warnings.unshift(`Only ${titles.join(", ")} ${titles.length === 1 ? "was" : "were"} restored. Everything else is exactly as it was.`);
    }
    let filesRemoved = 0;
    try {
      filesRemoved = await this.removeStrayFiles(out);
    } catch (err) {
      warnings.push(`The data is restored, but uploaded files made since could not be removed from storage: ${message(err)}`);
    }
    this.auth.invalidateAllUsers();
    this.settings.invalidateAll();
    void this.search.reindexEverywhere().catch((err: unknown) => this.logger.warn(`reindex after restore failed: ${message(err)}`));
    await this.pruneSafetyBackups().catch(() => undefined);

    return {
      backupId: row.id,
      safetyBackupId,
      rowsAdded: counts.rowsAdded,
      rowsRemoved: counts.rowsRemoved,
      rowsChanged: counts.rowsChanged,
      filesRestored: files,
      filesRemoved,
      rowsSkipped: out.skippedRows,
      rowsKept: out.keptRows,
      sections: scope ? scope.sections : null,
      warnings,
    };
  }

  /** Put back the files the backup has and storage lacks; verify each against the checksum the backup recorded. */
  private async restoreFiles(row: BackupRow, out: DiffOutput, tracker: Tracker): Promise<number> {
    if (!out.manifest.includeFiles || !out.fileIndex) return 0;
    const storage = new Map((await this.store.list(FILES_PREFIX)).map((o) => [o.key, o.size]));
    const index = new Map(out.fileIndex.map((f) => [f.key, f]));
    const written = new Map<string, { sha256: string; wasNew: boolean }>();
    const todo = out.fileIndex.filter((f) => storage.get(f.key) !== f.size).length;
    let done = 0;
    for await (const event of readArchive(this.archiveOf(row)(), { parseRows: false })) {
      if (event.type === "file") {
        const entry = index.get(event.key);
        if (!entry || storage.get(event.key) === event.size) continue; // already there (files are never rewritten in place)
        await tracker.progress({ label: "Restoring uploaded files", done: done++, total: todo });
        const hash = createHash("sha256");
        const body = (async function* () {
          for await (const chunk of event.body()) {
            hash.update(chunk);
            yield chunk;
          }
        })();
        await this.store.put(event.key, Readable.from(body), entry.contentType ?? "application/octet-stream", event.size);
        written.set(event.key, { sha256: hash.digest("hex"), wasNew: !storage.has(event.key) });
      } else if (event.type === "summary") {
        for (const f of event.summary.files) {
          const w = written.get(f.key);
          if (w && w.sha256 !== f.sha256) {
            await this.store.remove([...written.keys()].filter((k) => written.get(k)!.wasNew)).catch(() => undefined);
            throw new Error(`The file ${f.key} in the backup does not match its checksum; the restore was stopped before the data was touched.`);
          }
        }
      }
    }
    return written.size;
  }

  /** Uploaded files in storage that the restored data does not refer to. */
  private async removeStrayFiles(out: DiffOutput): Promise<number> {
    if (!out.manifest.includeFiles || !out.fileIndex) return 0;
    const wanted = new Set(out.fileIndex.map((f) => f.key));
    const stray = (await this.store.list(FILES_PREFIX)).map((o) => o.key).filter((k) => k.startsWith(FILES_PREFIX) && !wanted.has(k));
    await this.store.remove(stray);
    return stray.length;
  }

  private async pruneSafetyBackups(): Promise<void> {
    const old = await this.db.select().from(backups).where(eq(backups.kind, "pre_restore")).orderBy(desc(backups.createdAt)).offset(KEEP_PRE_RESTORE);
    for (const r of old) await this.removeBackup(r).catch((err: unknown) => this.logger.warn(`could not remove safety backup ${r.id}: ${message(err)}`));
  }

  // ------------------------------------------------------------------ downloading and deleting

  private sign(payload: string): string {
    return createHmac("sha256", process.env.AUTH_SECRET ?? "").update(`backup-download/v1:${payload}`).digest("base64url");
  }

  /** A link valid for a few minutes, for this person only. Creating it is the audited step. */
  async createDownloadToken(userId: string, backupId: string): Promise<{ token: string; filename: string; expiresAt: string }> {
    const row = await this.readyRow(backupId);
    const exp = Date.now() + DOWNLOAD_LINK_TTL_MS;
    const payload = `${backupId}.${userId}.${exp}`;
    return {
      token: `${Buffer.from(payload).toString("base64url")}.${this.sign(payload)}`,
      filename: this.downloadName(row),
      expiresAt: new Date(exp).toISOString(),
    };
  }

  private downloadName(row: BackupRow): string {
    return `${safeFilename(row.name)}-${row.createdAt.toISOString().slice(0, 10)}.tar.gz`;
  }

  async openDownload(userId: string, token: string): Promise<{ stream: Readable; filename: string; size: number | null }> {
    const [encoded, sig] = token.split(".");
    if (!encoded || !sig) throw new BadRequestException("Invalid download link");
    const payload = Buffer.from(encoded, "base64url").toString("utf8");
    const expected = this.sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BadRequestException("Invalid download link");
    const [backupId, linkUser, exp] = payload.split(".") as [string, string, string];
    if (linkUser !== userId) throw new BadRequestException("That download link belongs to someone else.");
    if (Date.now() > Number(exp)) throw new BadRequestException("That download link has expired. Start the download again.");
    const row = await this.readyRow(backupId);
    return { stream: await this.store.get(row.s3Key), filename: this.downloadName(row), size: row.sizeBytes === null ? null : Number(row.sizeBytes) };
  }

  /**
   * Remove the archive, then its row. If the store refuses, the row stays (so nothing is left in
   * storage with no record of it) and the error is passed on.
   */
  private async removeBackup(row: BackupRow): Promise<void> {
    await this.store.remove([row.s3Key]);
    await this.db.delete(backups).where(eq(backups.id, row.id));
  }

  async delete(id: string): Promise<{ ok: true }> {
    const row = await this.row(id);
    if (row.status === "running") throw new ConflictException("That backup is still being made.");
    const busy = await this.db
      .select({ id: backupOperations.id })
      .from(backupOperations)
      .where(and(eq(backupOperations.backupId, id), eq(backupOperations.status, "running")))
      .limit(1);
    if (busy.length > 0) throw new ConflictException("That backup is in use by a running operation.");
    await this.removeBackup(row);
    return { ok: true };
  }

  // ------------------------------------------------------------------ schedules

  private toSchedule(r: ScheduleRow): BackupSchedule {
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      frequency: r.frequency as BackupSchedule["frequency"],
      time: r.timeOfDay,
      dayOfWeek: r.dayOfWeek,
      dayOfMonth: r.dayOfMonth,
      timezone: r.timezone,
      keep: r.keepCount,
      includeFiles: r.includeFiles,
      lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
      lastStatus: (r.lastStatus as BackupSchedule["lastStatus"]) ?? null,
      lastError: r.lastError,
      nextRunAt: r.nextRunAt ? r.nextRunAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async listSchedules(): Promise<BackupSchedule[]> {
    const rows = await this.db.select().from(backupSchedules).orderBy(asc(backupSchedules.name));
    return rows.map((r) => this.toSchedule(r));
  }

  private nextRun(s: { frequency: string; timeOfDay: string; dayOfWeek: number; dayOfMonth: number; timezone: string }, from = new Date()): Date {
    return nextRunAfter(
      { frequency: s.frequency as BackupSchedule["frequency"], time: s.timeOfDay, dayOfWeek: s.dayOfWeek, dayOfMonth: s.dayOfMonth, timezone: s.timezone },
      from,
    );
  }

  async createSchedule(user: { id: string }, input: BackupScheduleInput): Promise<BackupSchedule> {
    const values = {
      name: input.name,
      enabled: input.enabled,
      frequency: input.frequency,
      timeOfDay: input.time,
      dayOfWeek: input.dayOfWeek,
      dayOfMonth: input.dayOfMonth,
      timezone: input.timezone,
      keepCount: input.keep,
      includeFiles: input.includeFiles,
    };
    const [r] = await this.db
      .insert(backupSchedules)
      .values({ ...values, nextRunAt: input.enabled ? this.nextRun(values) : null, createdBy: user.id })
      .returning();
    return this.toSchedule(r!);
  }

  async updateSchedule(id: string, input: BackupScheduleUpdate): Promise<BackupSchedule> {
    const [cur] = await this.db.select().from(backupSchedules).where(eq(backupSchedules.id, id)).limit(1);
    if (!cur) throw new NotFoundException("Schedule not found");
    const merged = {
      name: input.name ?? cur.name,
      enabled: input.enabled ?? cur.enabled,
      frequency: input.frequency ?? cur.frequency,
      timeOfDay: input.time ?? cur.timeOfDay,
      dayOfWeek: input.dayOfWeek ?? cur.dayOfWeek,
      dayOfMonth: input.dayOfMonth ?? cur.dayOfMonth,
      timezone: input.timezone ?? cur.timezone,
      keepCount: input.keep ?? cur.keepCount,
      includeFiles: input.includeFiles ?? cur.includeFiles,
    };
    const [r] = await this.db
      .update(backupSchedules)
      .set({ ...merged, nextRunAt: merged.enabled ? this.nextRun(merged) : null, updatedAt: sql`now()` })
      .where(eq(backupSchedules.id, id))
      .returning();
    return this.toSchedule(r!);
  }

  /** Deleting a schedule keeps the backups it made (they just stop being counted against it). */
  async deleteSchedule(id: string): Promise<{ ok: true }> {
    const res = await this.db.delete(backupSchedules).where(eq(backupSchedules.id, id)).returning({ id: backupSchedules.id });
    if (res.length === 0) throw new NotFoundException("Schedule not found");
    return { ok: true };
  }

  /** Make the schedule's backup right now, besides its usual times. */
  async runScheduleNow(user: { id: string }, id: string): Promise<{ operationId: string }> {
    const [s] = await this.db.select().from(backupSchedules).where(eq(backupSchedules.id, id)).limit(1);
    if (!s) throw new NotFoundException("Schedule not found");
    const mutex = await this.takeOperationLease();
    let tracker: Tracker;
    try {
      tracker = await this.startOperation("backup", null, user.id, "Starting");
    } catch (err) {
      await mutex.release();
      throw err;
    }
    this.background("scheduled backup (manual run)", async () => {
      try {
        await this.runScheduled(s, tracker, user.id);
      } finally {
        await mutex.release();
      }
    });
    return { operationId: tracker.id };
  }

  /** One run of a schedule: make the backup, record the outcome, move the next run on, delete the oldest. */
  private async runScheduled(s: ScheduleRow, tracker: Tracker, userId: string | null): Promise<void> {
    const stamp = new Intl.DateTimeFormat("en-GB", { timeZone: s.timezone, dateStyle: "medium", timeStyle: "short" }).format(new Date());
    try {
      const { backupId, row } = await this.makeBackup({ name: `${s.name} - ${stamp}`, kind: "scheduled", includeFiles: s.includeFiles, userId, scheduleId: s.id, tracker });
      await this.db
        .update(backupSchedules)
        .set({ lastRunAt: sql`now()`, lastStatus: "ok", lastError: null, nextRunAt: s.enabled ? this.nextRun(s) : null, updatedAt: sql`now()` })
        .where(eq(backupSchedules.id, s.id));
      await tracker.succeed({ backupId, sizeBytes: row.sizeBytes });
      await this.pruneSchedule(s).catch((err: unknown) => this.logger.warn(`pruning ${s.name} failed: ${message(err)}`));
    } catch (err) {
      const msg = message(err);
      await this.db
        .update(backupSchedules)
        .set({ lastRunAt: sql`now()`, lastStatus: "failed", lastError: msg.slice(0, 1000), nextRunAt: s.enabled ? this.nextRun(s) : null, updatedAt: sql`now()` })
        .where(eq(backupSchedules.id, s.id));
      await tracker.fail(msg);
      await this.notifyFailure(s.name, msg);
    }
  }

  private async pruneSchedule(s: ScheduleRow): Promise<void> {
    const old = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.scheduleId, s.id), eq(backups.status, "ready")))
      .orderBy(desc(backups.createdAt))
      .offset(s.keepCount);
    for (const r of old) await this.removeBackup(r).catch((err: unknown) => this.logger.warn(`could not remove ${r.id}: ${message(err)}`));
    // Failed attempts are only useful for a little while.
    const stale = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.scheduleId, s.id), eq(backups.status, "failed"), lte(backups.createdAt, sql`now() - interval '7 days'`)));
    for (const r of stale) await this.removeBackup(r).catch((err: unknown) => this.logger.warn(`could not remove ${r.id}: ${message(err)}`));
  }

  private async notifyFailure(scheduleName: string, error: string): Promise<void> {
    try {
      const [adminGroup] = await this.db.select({ id: groups.id }).from(groups).where(eq(groups.name, DEFAULT_GROUPS.ADMIN)).limit(1);
      if (!adminGroup) return;
      const admins = await this.db.select({ userId: groupMemberships.userId }).from(groupMemberships).where(eq(groupMemberships.groupId, adminGroup.id));
      await this.notifications.createMany(
        admins.map((a) => ({
          recipientUserId: a.userId,
          kind: "backup.failed",
          title: `Scheduled backup failed: ${scheduleName}`,
          body: error.slice(0, 500),
          link: "/admin/backups?tab=schedules",
        })),
      );
    } catch (err) {
      this.logger.warn(`could not notify admins of a failed backup: ${message(err)}`);
    }
  }

  // ------------------------------------------------------------------ the scheduler

  /** Every minute, on the one node leading the job. */
  async tick(): Promise<void> {
    await this.recoverStale();
    const due = await this.db
      .select()
      .from(backupSchedules)
      .where(and(eq(backupSchedules.enabled, true), isNotNull(backupSchedules.nextRunAt), lte(backupSchedules.nextRunAt, sql`now()`)))
      .orderBy(asc(backupSchedules.nextRunAt));
    for (const s of due) {
      // Another operation is running: leave the schedule due, try again next minute.
      const mutex = await this.leases.acquireMutex(OPERATION_LEASE, OPERATION_LEASE_TTL_SEC);
      if (!mutex) return;
      try {
        const tracker = await this.startOperation("backup", null, null, "Starting");
        await this.runScheduled(s, tracker, null);
      } finally {
        await mutex.release();
      }
    }
  }

  /** Mark work that a dead node left behind as failed, so it does not look like it is still going. */
  private async recoverStale(): Promise<void> {
    await this.db
      .update(backupOperations)
      .set({ status: "failed", error: "The node doing this stopped before it finished.", finishedAt: sql`now()` })
      .where(and(eq(backupOperations.status, "running"), lte(backupOperations.updatedAt, sql`now() - ${`${STALE_OPERATION_MINUTES} minutes`}::interval`)));
    const running = this.db.select({ id: backupOperations.backupId }).from(backupOperations).where(and(eq(backupOperations.status, "running"), isNotNull(backupOperations.backupId)));
    await this.db
      .update(backups)
      .set({ status: "failed", finishedAt: sql`now()`, error: "The node making this stopped before it finished." })
      .where(and(eq(backups.status, "running"), lte(backups.createdAt, sql`now() - interval '10 minutes'`), sql`${backups.id} NOT IN (${running})`));
  }
}

