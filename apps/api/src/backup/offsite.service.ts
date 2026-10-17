import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import {
  OFFSITE_KEYS,
  OFFSITE_RETRY_MINUTES,
  isOffsiteArchiveKey,
  normaliseOffsitePrefix,
  offsiteKeyTime,
  offsiteKeysToDelete,
  offsiteMissing,
  offsiteObjectKey,
  type BackupOffsiteDestination,
  type BackupOffsiteObject,
  type BackupOffsiteStatus,
  type BackupOffsiteTest,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { backupSchedules, backups } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { makeS3Client } from "../attachments/s3.client";
import { describeS3, resolveS3Config, type S3Config } from "../attachments/s3.config";
import { BackupService, type Tracker } from "./backup.service";
import { OBJECT_STORE, S3ObjectStore, type ObjectStore } from "./object-store";

type BackupRow = typeof backups.$inferSelect;

/** Builds the store for an offsite destination. The real one talks S3; tests hand back an in-memory store. */
export type OffsiteStoreFactory = (config: S3Config) => ObjectStore;
export const OFFSITE_STORE_FACTORY = Symbol("OFFSITE_STORE_FACTORY");
export const s3OffsiteStoreFactory: OffsiteStoreFactory = (config) => {
  const client = makeS3Client(config);
  return new S3ObjectStore(() => ({ client, bucket: config.bucket }));
};

interface Destination {
  config: S3Config;
  prefix: string;
  keep: number;
  store: ObjectStore;
  /** Short hash of endpoint, bucket and folder: a copy belongs to the destination that holds it. */
  id: string;
}

type Resolved = { ok: true; dest: Destination } | { ok: false; reason: string; missing: string | null };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the store said, shortened to something that fits a notice and does not leak a request id wall. */
function tidy(err: unknown): string {
  return message(err).replace(/\s+/g, " ").slice(0, 400);
}

/**
 * Copies of backups kept in a second S3-compatible bucket, so that losing this machine (or its object store)
 * does not lose the backups. The archive is copied byte for byte and checked afterwards (size, and the checksum
 * recorded when it was made); settings live in the `backup` category (admin > Settings > Backups).
 */
@Injectable()
export class OffsiteService implements OnModuleInit {
  private readonly logger = new Logger(OffsiteService.name);
  /** Warnings from the latest run (a failed delete at the destination). Per node; the operation result keeps them too. */
  private lastWarnings: string[] = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OBJECT_STORE) private readonly local: ObjectStore,
    @Inject(OFFSITE_STORE_FACTORY) private readonly makeStore: OffsiteStoreFactory,
    private readonly settings: SettingsService,
    private readonly backupsService: BackupService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "backup-offsite",
      everyMs: 5 * 60_000,
      schedule: "fixed-delay",
      initialDelayMs: 90_000,
      run: () => this.tick(),
    });
  }

  // ------------------------------------------------------------------ settings

  private async read() {
    const [enabled, endpoint, bucket, region, prefix, accessKey, secretKey, pathStyle, keep] = await Promise.all([
      this.settings.get(OFFSITE_KEYS.enabled),
      this.settings.get(OFFSITE_KEYS.endpoint),
      this.settings.get(OFFSITE_KEYS.bucket),
      this.settings.get(OFFSITE_KEYS.region),
      this.settings.get(OFFSITE_KEYS.prefix),
      this.settings.get(OFFSITE_KEYS.accessKey),
      this.settings.get(OFFSITE_KEYS.secretKey),
      this.settings.get(OFFSITE_KEYS.pathStyle),
      this.settings.get(OFFSITE_KEYS.keep),
    ]);
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      enabled: enabled === true,
      endpoint: str(endpoint),
      bucket: str(bucket),
      region: str(region) || "us-east-1",
      prefix: typeof prefix === "string" ? prefix : "church-dashboard/",
      accessKey: str(accessKey),
      secretKey: str(secretKey),
      pathStyle: pathStyle !== false,
      keep: typeof keep === "number" && Number.isFinite(keep) && keep >= 0 ? Math.floor(keep) : 14,
    };
  }

  /** The destination described by the settings, whether or not copies are switched on. */
  private async resolve(): Promise<Resolved & { values: Awaited<ReturnType<OffsiteService["read"]>> }> {
    const values = await this.read();
    const missing = offsiteMissing(values);
    if (missing) return { ok: false, reason: `Set ${missing} first.`, missing, values };
    const folder = normaliseOffsitePrefix(values.prefix);
    if (!folder.ok) return { ok: false, reason: folder.error, missing: null, values };
    let config: S3Config;
    try {
      config = resolveS3Config({
        S3_ENDPOINT: values.endpoint,
        S3_BUCKET: values.bucket,
        S3_REGION: values.region,
        S3_ACCESS_KEY: values.accessKey,
        S3_SECRET_KEY: values.secretKey,
        S3_PATH_STYLE: values.pathStyle ? "true" : "false",
      });
    } catch (err) {
      return { ok: false, reason: message(err).replace(/^S3_ENDPOINT/, "The endpoint"), missing: null, values };
    }
    if (this.sameStoreAsApp(config)) {
      return { ok: false, reason: "That is the bucket this site keeps its own files and backups in. An offsite copy has to be somewhere else.", missing: null, values };
    }
    const id = createHash("sha256").update(`${config.endPoint}:${config.port ?? ""}|${config.bucket}|${folder.prefix}`).digest("hex").slice(0, 16);
    return { ok: true, dest: { config, prefix: folder.prefix, keep: values.keep, store: this.makeStore(config), id }, values };
  }

  private sameStoreAsApp(config: S3Config): boolean {
    try {
      const own = resolveS3Config();
      return own.bucket === config.bucket && own.endPoint.toLowerCase() === config.endPoint.toLowerCase() && own.port === config.port;
    } catch {
      return false;
    }
  }

  private describe(dest: Destination): BackupOffsiteDestination {
    const d = describeS3(dest.config);
    return { endpoint: d.endpoint ?? "", bucket: dest.config.bucket, folder: dest.prefix, region: dest.config.region };
  }

  /** The destination copies are made to, or the reason they cannot be: refuses when switched off. */
  private async usable(): Promise<Destination> {
    const r = await this.resolve();
    if (!r.ok) throw new BadRequestException(r.reason);
    if (!r.values.enabled) throw new BadRequestException("Offsite copies are switched off. Turn them on in Settings > Backups.");
    return r.dest;
  }

  // ------------------------------------------------------------------ status

  /** Rows that should be copied to `dest` and have not been: ready, scheduled, in a schedule that wants it, within "keep". */
  private async wanted(dest: Destination): Promise<BackupRow[]> {
    const eligible = await this.db
      .select({ b: backups })
      .from(backups)
      .innerJoin(backupSchedules, eq(backups.scheduleId, backupSchedules.id))
      .where(and(eq(backups.status, "ready"), eq(backups.kind, "scheduled"), eq(backupSchedules.offsite, true)))
      .orderBy(desc(backups.createdAt))
      .limit(dest.keep > 0 ? dest.keep : 1000);
    return eligible.map((e) => e.b).filter((b) => !(b.offsiteAt && b.offsiteKey && b.offsiteDest === dest.id));
  }

  async status(): Promise<BackupOffsiteStatus> {
    const r = await this.resolve();
    const v = r.values;
    const dest = r.ok ? r.dest : null;
    const counts = await this.db
      .select({
        copied: sql<number>`count(*) FILTER (WHERE ${backups.offsiteKey} IS NOT NULL AND ${backups.offsiteDest} = ${dest?.id ?? ""})`,
        failing: sql<number>`count(*) FILTER (WHERE ${backups.offsiteError} IS NOT NULL)`,
        lastAt: sql<string | number | null>`extract(epoch FROM max(${backups.offsiteAt}) FILTER (WHERE ${backups.offsiteKey} IS NOT NULL AND ${backups.offsiteDest} = ${dest?.id ?? ""})) * 1000`,
      })
      .from(backups);
    const [lastFail] = await this.db
      .select({ error: backups.offsiteError })
      .from(backups)
      .where(isNotNull(backups.offsiteError))
      .orderBy(desc(backups.offsiteTriedAt))
      .limit(1);
    const pending = dest && v.enabled ? (await this.wanted(dest)).length : 0;
    const lastAt = counts[0]?.lastAt;
    return {
      enabled: v.enabled,
      configured: r.ok || r.missing === null,
      missing: r.ok ? null : r.missing,
      problem: r.ok ? null : r.missing ? null : r.reason,
      destination: dest ? this.describe(dest) : null,
      keep: v.keep,
      pending,
      failing: Number(counts[0]?.failing ?? 0),
      copied: Number(counts[0]?.copied ?? 0),
      lastCopyAt: lastAt != null ? new Date(Number(lastAt)).toISOString() : null,
      lastError: lastFail?.error ?? null,
      warnings: this.lastWarnings,
    };
  }

  // ------------------------------------------------------------------ trying the destination

  /**
   * Write, read back and delete a small test object in the destination, so a wrong key, bucket or endpoint is found
   * now and not when the first backup is due. A key that can write but not delete is fine (and reported): copies
   * older than "copies to keep" then stay in the bucket.
   */
  async test(): Promise<BackupOffsiteTest> {
    const r = await this.resolve();
    if (!r.ok) return { ok: false, message: r.reason, canDelete: false };
    const { store, prefix } = r.dest;
    const probe = `${prefix}.church-dashboard-write-test-${randomUUID().slice(0, 8)}`;
    const body = Buffer.from("church dashboard offsite backup test\n");
    try {
      await store.list(prefix);
    } catch (err) {
      return { ok: false, message: `Could not list the bucket: ${tidy(err)}`, canDelete: false };
    }
    try {
      await store.put(probe, body, "text/plain");
      const seen = await store.stat(probe);
      if (!seen || seen.size !== body.length) throw new Error("the test file was not found afterwards, or has the wrong size");
    } catch (err) {
      await store.remove([probe]).catch(() => undefined);
      return { ok: false, message: `Could not write to the bucket: ${tidy(err)}`, canDelete: false };
    }
    let canDelete = true;
    try {
      await store.remove([probe]);
      if (await store.stat(probe)) canDelete = false;
    } catch {
      canDelete = false;
    }
    return canDelete
      ? { ok: true, message: "Connected. The key can list, write and delete in that bucket.", canDelete }
      : {
          ok: true,
          message: `Connected. The key can write but not delete, so copies older than "Copies to keep" will stay in the bucket. The test file ${probe} was left there; delete it by hand.`,
          canDelete,
        };
  }

  // ------------------------------------------------------------------ copying

  /** Every five minutes, on the node leading the job: copy what is waiting. */
  async tick(): Promise<void> {
    const r = await this.resolve();
    if (!r.ok || !r.values.enabled) return;
    const now = Date.now();
    const todo = (await this.wanted(r.dest)).filter((b) => !b.offsiteError || !b.offsiteTriedAt || now - b.offsiteTriedAt.getTime() > OFFSITE_RETRY_MINUTES * 60_000);
    if (todo.length === 0) return;
    const op = await this.backupsService.beginOperation("offsite", null, null, "Copying to the offsite bucket");
    if (!op) return; // another backup operation is running; the next tick tries again
    try {
      await this.runCopies(op.tracker, r.dest, todo);
    } finally {
      await op.mutex.release();
    }
  }

  /** Copy everything waiting (or one backup) now, in the background. */
  async startCopy(user: { id: string }, backupId?: string): Promise<{ operationId: string }> {
    const dest = await this.usable();
    let todo: BackupRow[];
    if (backupId) {
      const [row] = await this.db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
      if (!row) throw new NotFoundException("Backup not found");
      if (row.status !== "ready") throw new BadRequestException(row.status === "running" ? "That backup is still being made." : "That backup failed and cannot be copied.");
      todo = [row];
    } else {
      todo = await this.wanted(dest);
    }
    const op = await this.backupsService.beginOperation("offsite", backupId ?? null, user.id, "Copying to the offsite bucket");
    if (!op) throw new ConflictException("Another backup, import, comparison or restore is running. Wait for it to finish.");
    this.backupsService.background("offsite copy", async () => {
      try {
        await this.runCopies(op.tracker, dest, todo, true);
      } finally {
        await op.mutex.release();
      }
    });
    return { operationId: op.tracker.id };
  }

  private async runCopies(tracker: Tracker, dest: Destination, todo: BackupRow[], pruneEvenIfNone = false): Promise<void> {
    const warnings: string[] = [];
    let copied = 0;
    const failures: string[] = [];
    try {
      for (const row of todo) {
        try {
          await this.copyOne(row, dest, tracker);
          copied++;
        } catch (err) {
          failures.push(`${row.name}: ${tidy(err)}`);
        }
      }
      let deleted = 0;
      if (copied > 0 || pruneEvenIfNone) {
        const pruned = await this.prune(dest).catch((err: unknown) => {
          warnings.push(`Could not tidy the bucket: ${tidy(err)}`);
          return { deleted: 0, warning: null as string | null };
        });
        deleted = pruned.deleted;
        if (pruned.warning) warnings.push(pruned.warning);
      }
      this.lastWarnings = warnings;
      if (failures.length > 0 && copied === 0) await tracker.fail(failures.join(" | ").slice(0, 1900));
      else await tracker.succeed({ copied, failed: failures.length, deleted, warnings, errors: failures });
    } catch (err) {
      await tracker.fail(tidy(err));
    }
  }

  private async copyOne(row: BackupRow, dest: Destination, tracker: Tracker): Promise<void> {
    const key = offsiteObjectKey(dest.prefix, row.createdAt, row.id);
    const priorError = row.offsiteError;
    await this.backupsService.setOperationBackup(tracker.id, row.id);
    await this.db.update(backups).set({ offsiteTriedAt: sql`now()` }).where(eq(backups.id, row.id));
    const expected = row.sizeBytes === null ? null : Number(row.sizeBytes);
    try {
      if (expected === null || expected <= 0) throw new Error("the backup has no recorded size");
      const source: Readable = await this.local.get(row.s3Key);
      const hash = createHash("sha256");
      let sent = 0;
      // A Transform, not a 'data' listener: a listener would start the stream flowing before the upload reads it.
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk);
          sent += chunk.length;
          void tracker.progress({ label: `Copying ${row.name}`, done: sent, total: expected });
          cb(null, chunk);
        },
      });
      source.once("error", (e) => counter.destroy(e));
      source.pipe(counter);
      try {
        await dest.store.put(key, counter, "application/gzip", expected);
      } catch (err) {
        source.destroy();
        counter.destroy();
        throw err;
      }
      const digest = hash.digest("hex");
      if (row.sha256 && digest !== row.sha256) {
        await dest.store.remove([key]).catch(() => undefined);
        throw new Error("the archive on this site no longer matches the checksum recorded when it was made, so it was not kept offsite");
      }
      const seen = await dest.store.stat(key);
      if (!seen || seen.size !== expected) {
        await dest.store.remove([key]).catch(() => undefined);
        throw new Error(`the copy was not found in the bucket afterwards, or has the wrong size (${seen ? seen.size : 0} of ${expected} bytes)`);
      }
      await this.db
        .update(backups)
        .set({ offsiteAt: sql`now()`, offsiteKey: key, offsiteDest: dest.id, offsiteError: null })
        .where(eq(backups.id, row.id));
    } catch (err) {
      const msg = tidy(err);
      await this.db.update(backups).set({ offsiteError: msg }).where(eq(backups.id, row.id)).catch(() => undefined);
      // One notice until something succeeds again, not one per failed retry or per backup.
      if (!priorError) {
        const [other] = await this.db.select({ n: sql<number>`count(*)` }).from(backups).where(and(isNotNull(backups.offsiteError), sql`${backups.id} <> ${row.id}`));
        if (Number(other?.n ?? 0) === 0) {
          await this.backupsService.notifyAdmins(`Offsite backup copy failed: ${row.name}`, msg, "/admin/backups?tab=offsite");
        }
      }
      throw err;
    }
  }

  /** Keep the newest `keep` copies in the destination. Only files named like ours are ever deleted. */
  private async prune(dest: Destination): Promise<{ deleted: number; warning: string | null }> {
    if (dest.keep <= 0) return { deleted: 0, warning: null };
    const objects = await dest.store.list(dest.prefix);
    const doomed = offsiteKeysToDelete(dest.prefix, objects.map((o) => o.key), dest.keep);
    if (doomed.length === 0) return { deleted: 0, warning: null };
    const gone: string[] = [];
    let firstError: string | null = null;
    for (const key of doomed) {
      try {
        await dest.store.remove([key]);
        gone.push(key);
      } catch (err) {
        firstError ??= tidy(err);
      }
    }
    if (gone.length > 0) {
      await this.db.update(backups).set({ offsiteKey: null }).where(inArray(backups.offsiteKey, gone));
    }
    return {
      deleted: gone.length,
      warning: firstError ? `${doomed.length - gone.length} older cop${doomed.length - gone.length === 1 ? "y" : "ies"} could not be deleted from the bucket (${firstError}). Give the key delete access, or delete them there by hand.` : null,
    };
  }

  // ------------------------------------------------------------------ bringing a copy back

  /** The copies in the destination, newest first. Works while copying is switched off, so a fresh install can reach old ones. */
  async objects(): Promise<BackupOffsiteObject[]> {
    const r = await this.resolve();
    if (!r.ok) throw new BadRequestException(r.reason);
    const found = (await r.dest.store.list(r.dest.prefix).catch((err: unknown) => {
      throw new BadRequestException(`Could not list the bucket: ${tidy(err)}`);
    })).filter((o) => isOffsiteArchiveKey(r.dest.prefix, o.key));
    const known = await this.db
      .select({ id: backups.id, key: backups.offsiteKey })
      .from(backups)
      .where(inArray(backups.offsiteKey, found.length > 0 ? found.map((o) => o.key) : [""]));
    const byKey = new Map(known.map((k) => [k.key, k.id]));
    return found
      .map((o) => ({
        key: o.key,
        name: o.key.slice(r.dest.prefix.length),
        sizeBytes: o.size,
        createdAt: offsiteKeyTime(r.dest.prefix, o.key)?.toISOString() ?? null,
        backupId: byKey.get(o.key) ?? null,
      }))
      .sort((a, b) => (a.key < b.key ? 1 : -1));
  }

  /**
   * Bring a copy back into this site's backup list (as an uploaded backup, checked like one), from where it can be
   * compared and restored as usual. The key must be one of ours: this never reads other files in the bucket.
   */
  async fetch(user: { id: string }, key: string): Promise<{ backupId: string; operationId: string }> {
    const r = await this.resolve();
    if (!r.ok) throw new BadRequestException(r.reason);
    if (!isOffsiteArchiveKey(r.dest.prefix, key)) throw new BadRequestException("That is not a backup copy made by this site.");
    const seen = await r.dest.store.stat(key).catch((err: unknown) => {
      throw new BadRequestException(`Could not read the bucket: ${tidy(err)}`);
    });
    if (!seen) throw new NotFoundException("That copy is no longer in the bucket.");
    const stream = await r.dest.store.get(key);
    try {
      return await this.backupsService.importUpload(user, key.slice(r.dest.prefix.length), stream, () => false);
    } catch (err) {
      stream.destroy();
      throw err;
    }
  }
}
