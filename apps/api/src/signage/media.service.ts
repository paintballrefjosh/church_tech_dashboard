import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { ConflictException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException, type OnModuleInit } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { SIGNAGE_LIMITS, type SignageMedia, type SignageMediaKind, type SignageMediaStatus } from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { signageMedia, signagePlaylistItems, signagePlaylists } from "../db/schema";
import { getS3 } from "../attachments/s3.client";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SignageService } from "./signage.service";
import { signageMediaKey, signageThumbKey, signageUploadKey } from "./constants";
import { ffmpeg, probe, renditionArgs, sha256File, thumbArgs, VIDEO_BOX, videoTooLarge } from "./media-tools";

type MediaRow = typeof signageMedia.$inferSelect;

/** A conversion holds its row this long; a dead node's claim lapses and another node takes the file. */
const CLAIM_MIN = 45;

/**
 * Signage media (docs/signage.md section 9). An upload is streamed to a temporary file and then to the object store under
 * `signage/uploads/`, so any node can convert it; the `signage-media` job (one file at a time per node) probes it with
 * ffprobe (the file's own bytes decide what it is), makes the rendition and a thumbnail, names the rendition by its
 * sha256 and deletes the upload. Two uploads that convert to the same bytes share one stored file.
 */
@Injectable()
export class SignageMediaService implements OnModuleInit {
  private readonly logger = new Logger(SignageMediaService.name);
  private busy = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly content: SignageService,
  ) {}

  onModuleInit(): void {
    // The job leader converts one file per tick; the row's claim also keeps a file from being converted twice across a
    // leader handover (a dead node's claim lapses after CLAIM_MIN).
    this.jobs.register({ name: "signage-media", everyMs: 10_000, initialDelayMs: 20_000, schedule: "fixed-delay", run: () => this.tick() });
    // After a restore the rows may name files storage does not have (a backup without signage media), or have them again.
    this.jobs.register({ name: "signage-media-check", everyMs: 3_600_000, initialDelayMs: 120_000, run: () => this.markMissing().then(() => undefined) });
  }

  private async dtos(rows: MediaRow[]): Promise<SignageMedia[]> {
    const ids = rows.map((r) => r.id);
    const uses = ids.length
      ? await this.db
          .selectDistinct({ mediaId: signagePlaylistItems.mediaId, playlistId: signagePlaylists.id, playlistName: signagePlaylists.name })
          .from(signagePlaylistItems)
          .innerJoin(signagePlaylists, eq(signagePlaylists.id, signagePlaylistItems.playlistId))
          .where(inArray(signagePlaylistItems.mediaId, ids))
      : [];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind as SignageMediaKind | null,
      status: r.status as SignageMediaStatus,
      originalName: r.originalName,
      sha256: r.sha256,
      width: r.width,
      height: r.height,
      durationS: r.durationS,
      sizeBytes: r.sizeBytes,
      error: r.error,
      hasThumb: !!r.thumbKey,
      usedBy: uses.filter((u) => u.mediaId === r.id).map((u) => ({ playlistId: u.playlistId, playlistName: u.playlistName })),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async list(): Promise<SignageMedia[]> {
    return this.dtos(await this.db.select().from(signageMedia).orderBy(asc(signageMedia.name)));
  }

  async row(id: string): Promise<MediaRow> {
    const [r] = await this.db.select().from(signageMedia).where(eq(signageMedia.id, id)).limit(1);
    if (!r) throw new NotFoundException("Media not found");
    return r;
  }

  async get(id: string): Promise<SignageMedia> {
    return (await this.dtos([await this.row(id)]))[0]!;
  }

  async rename(id: string, name: string): Promise<SignageMedia> {
    await this.row(id);
    await this.db.update(signageMedia).set({ name, updatedAt: new Date() }).where(eq(signageMedia.id, id));
    this.content.searchChanged();
    return this.get(id);
  }

  /** Store an upload (the multipart stream) for the converter. Refused over 500 MiB with nothing kept. */
  async upload(filename: string, mime: string, file: Readable, truncated: () => boolean, userId: string | null): Promise<SignageMedia> {
    const dir = await mkdtemp(join(tmpdir(), "signage-up-"));
    const path = join(dir, "upload");
    try {
      await pipeline(file, createWriteStream(path));
      if (truncated()) throw new PayloadTooLargeException(`Files can be at most ${Math.round(SIGNAGE_LIMITS.maxUploadBytes / 1024 / 1024)} MB.`);
      const size = (await stat(path)).size;
      if (size === 0) throw new ConflictException("The file is empty.");
      const id = randomUUID();
      const { client, bucket } = getS3();
      await client.putObject(bucket, signageUploadKey(id), createReadStream(path), size, { "Content-Type": "application/octet-stream" });
      const name = filename.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 120) || "Untitled";
      await this.db.insert(signageMedia).values({ id, name, originalName: filename.slice(0, 255), mime: mime.slice(0, 100), status: "uploaded", uploadKey: signageUploadKey(id), sizeBytes: size, createdBy: userId });
      this.content.searchChanged();
      return this.get(id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Delete media that no playlist uses (its stored file goes too, unless another row shares it). */
  async remove(id: string): Promise<void> {
    const r = await this.row(id);
    const [used] = await this.db.select({ n: sql<number>`count(*)` }).from(signagePlaylistItems).where(eq(signagePlaylistItems.mediaId, id));
    if (Number(used?.n ?? 0) > 0) throw new ConflictException("Playlists still use this. Take it out of them first.");
    await this.db.delete(signageMedia).where(eq(signageMedia.id, id));
    this.content.searchChanged();
    await this.deleteObjectsOf(r);
  }

  private async deleteObjectsOf(r: MediaRow): Promise<void> {
    const { client, bucket } = getS3();
    const keys: string[] = [];
    if (r.uploadKey) keys.push(r.uploadKey);
    if (r.sha256) {
      const [shared] = await this.db.select({ n: sql<number>`count(*)` }).from(signageMedia).where(and(eq(signageMedia.sha256, r.sha256), ne(signageMedia.id, r.id)));
      if (Number(shared?.n ?? 0) === 0) {
        if (r.storageKey) keys.push(r.storageKey);
        if (r.thumbKey) keys.push(r.thumbKey);
      }
    }
    for (const k of keys) await client.removeObject(bucket, k).catch((err: Error) => this.logger.warn(`signage media: could not delete ${k}: ${err.message}`));
  }

  /** The rendition or thumbnail as a stream (for the browser's preview and for copying to Pis), with Range support. */
  async open(id: string, which: "file" | "thumb", range?: { start: number; end?: number }): Promise<{ stream: Readable; size: number; contentType: string; start: number; end: number }> {
    const r = await this.row(id);
    const key = which === "thumb" ? r.thumbKey : r.storageKey;
    if (!key || r.status !== "ready") throw new NotFoundException(which === "thumb" ? "No thumbnail yet" : "The file is not ready");
    return this.openKey(key, which === "thumb" ? "image/jpeg" : contentTypeFor(r), range);
  }

  async openKey(key: string, contentType: string, range?: { start: number; end?: number }): Promise<{ stream: Readable; size: number; contentType: string; start: number; end: number }> {
    const { client, bucket } = getS3();
    const st = await client.statObject(bucket, key);
    const size = st.size;
    const start = Math.min(range?.start ?? 0, Math.max(0, size - 1));
    const end = Math.min(range?.end ?? size - 1, size - 1);
    const stream = start > 0 || end < size - 1 ? await client.getPartialObject(bucket, key, start, end - start + 1) : await client.getObject(bucket, key);
    return { stream, size, contentType, start, end };
  }

  /** One conversion per tick (the job runs on the leader only). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const [next] = await this.db
        .select({ id: signageMedia.id })
        .from(signageMedia)
        .where(and(inArray(signageMedia.status, ["uploaded", "processing"]), or(isNull(signageMedia.claimedUntil), lt(signageMedia.claimedUntil, sql`now()`))))
        .orderBy(asc(signageMedia.createdAt))
        .limit(1);
      if (!next) return this.refitNext();
      const claimed = await this.db
        .update(signageMedia)
        .set({ status: "processing", claimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
        .where(and(eq(signageMedia.id, next.id), or(isNull(signageMedia.claimedUntil), lt(signageMedia.claimedUntil, sql`now()`))))
        .returning();
      if (claimed[0]) await this.convert(claimed[0]);
    } finally {
      this.busy = false;
    }
  }

  async convert(r: MediaRow): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "signage-cv-"));
    const fail = async (error: string) => {
      await this.db.update(signageMedia).set({ status: "failed", error, claimedUntil: null, updatedAt: new Date() }).where(eq(signageMedia.id, r.id));
    };
    try {
      if (!r.uploadKey) return fail("The upload is gone; upload the file again.");
      const { client, bucket } = getS3();
      const src = join(dir, "src");
      try {
        await pipeline(await client.getObject(bucket, r.uploadKey), createWriteStream(src));
      } catch (err) {
        return fail(`The upload could not be read back: ${(err as Error).message}`);
      }
      const p = await probe(src);
      if ("error" in p) return fail(p.error);
      const png = p.kind === "image" && /png/i.test(r.mime + r.originalName);
      const ext = p.kind === "video" ? "mp4" : png ? "png" : "jpg";
      const out = join(dir, `out.${ext}`);
      const conv = await ffmpeg(renditionArgs(p.kind, src, out, p.width, p.height, png), p.kind === "video" ? 30 * 60_000 : 120_000);
      if (conv) return fail(conv);
      const made = await probe(out);
      if ("error" in made) return fail(`The converted file could not be read: ${made.error}`);
      const sha = await sha256File(out);
      const size = (await stat(out)).size;
      const thumb = join(dir, "thumb.jpg");
      const thumbErr = await ffmpeg(thumbArgs(out, thumb, made.durationS ? Math.min(made.durationS / 2, 10) : null), 60_000);
      const key = signageMediaKey(sha, ext);
      await client.putObject(bucket, key, createReadStream(out), size, { "Content-Type": p.kind === "video" ? "video/mp4" : png ? "image/png" : "image/jpeg" });
      let thumbKey: string | null = null;
      if (!thumbErr) {
        thumbKey = signageThumbKey(sha);
        await client.putObject(bucket, thumbKey, createReadStream(thumb), (await stat(thumb)).size, { "Content-Type": "image/jpeg" });
      }
      await this.db
        .update(signageMedia)
        .set({ status: "ready", kind: p.kind, sha256: sha, storageKey: key, thumbKey, width: made.width, height: made.height, durationS: made.durationS, sizeBytes: size, error: null, uploadKey: null, claimedUntil: null, updatedAt: new Date() })
        .where(eq(signageMedia.id, r.id));
      await client.removeObject(bucket, r.uploadKey).catch(() => undefined);
      await this.content.markDirty();
      this.content.searchChanged();
    } catch (err) {
      this.logger.warn(`signage media ${r.id}: ${(err as Error).message}`);
      await fail(`Converting failed: ${(err as Error).message}`.slice(0, 500));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * A video stored before videos were fitted to 1920x1080 (`renditionBox`) is converted again from its stored file, one per
   * tick when no upload is waiting. It stays `ready` throughout (screens keep playing the old file until the new one is
   * stored); the claim keeps two nodes from doing it twice. The old file is deleted unless another row shares it.
   */
  private async refitNext(): Promise<void> {
    const [next] = await this.db
      .select()
      .from(signageMedia)
      .where(and(eq(signageMedia.status, "ready"), eq(signageMedia.kind, "video"), or(sql`${signageMedia.width} > ${VIDEO_BOX.w}`, sql`${signageMedia.height} > ${VIDEO_BOX.h}`), or(isNull(signageMedia.claimedUntil), lt(signageMedia.claimedUntil, sql`now()`))))
      .orderBy(asc(signageMedia.createdAt))
      .limit(1);
    if (!next || !videoTooLarge(next.width, next.height)) return;
    const [claimed] = await this.db
      .update(signageMedia)
      .set({ claimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
      .where(and(eq(signageMedia.id, next.id), eq(signageMedia.status, "ready"), or(isNull(signageMedia.claimedUntil), lt(signageMedia.claimedUntil, sql`now()`))))
      .returning();
    if (claimed) await this.refit(claimed);
  }

  async refit(r: MediaRow): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "signage-refit-"));
    const release = (error: string | null) =>
      // A failure leaves the old file playing and says why; the claim is held for an hour so a file that cannot be converted is not retried every tick.
      this.db.update(signageMedia).set(error ? { error, claimedUntil: sql`now() + INTERVAL '1 hour'` } : { claimedUntil: null }).where(eq(signageMedia.id, r.id));
    try {
      if (!r.storageKey || !r.width || !r.height) return void (await release(null));
      const { client, bucket } = getS3();
      const src = join(dir, "src.mp4");
      await pipeline(await client.getObject(bucket, r.storageKey), createWriteStream(src));
      const out = join(dir, "out.mp4");
      const conv = await ffmpeg(renditionArgs("video", src, out, r.width, r.height, false), 30 * 60_000);
      if (conv) return void (await release(`Fitting the video to 1920x1080 failed: ${conv}`.slice(0, 500)));
      const made = await probe(out);
      if ("error" in made) return void (await release(`The refitted video could not be read: ${made.error}`.slice(0, 500)));
      const sha = await sha256File(out);
      const size = (await stat(out)).size;
      const key = signageMediaKey(sha, "mp4");
      await client.putObject(bucket, key, createReadStream(out), size, { "Content-Type": "video/mp4" });
      const thumb = join(dir, "thumb.jpg");
      let thumbKey: string | null = r.thumbKey;
      if (!(await ffmpeg(thumbArgs(out, thumb, made.durationS ? Math.min(made.durationS / 2, 10) : null), 60_000))) {
        thumbKey = signageThumbKey(sha);
        await client.putObject(bucket, thumbKey, createReadStream(thumb), (await stat(thumb)).size, { "Content-Type": "image/jpeg" });
      }
      const updated = await this.db
        .update(signageMedia)
        .set({ sha256: sha, storageKey: key, thumbKey, width: made.width, height: made.height, durationS: made.durationS, sizeBytes: size, error: null, claimedUntil: null, updatedAt: new Date() })
        .where(and(eq(signageMedia.id, r.id), eq(signageMedia.sha256, r.sha256 ?? "")))
        .returning({ id: signageMedia.id });
      if (!updated.length) return; // deleted or replaced meanwhile: leave the new file for the orphan sweep
      this.logger.log(`signage media ${r.id}: video fitted from ${r.width}x${r.height} to ${made.width}x${made.height}`);
      // The old thumbnail is kept when no new one could be made.
      if (r.sha256 !== sha) await this.deleteObjectsOf({ ...r, uploadKey: null, thumbKey: thumbKey === r.thumbKey ? null : r.thumbKey });
      await this.content.markDirty();
      this.content.searchChanged();
    } catch (err) {
      this.logger.warn(`signage media ${r.id}: refit failed: ${(err as Error).message}`);
      await release(`Fitting the video to 1920x1080 failed: ${(err as Error).message}`.slice(0, 500)).catch(() => undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Media whose stored file is gone (after a restore without the signage media) is marked `missing`, so the library says
   * to upload it again and screens skip it; one whose file is back (a later restore with the media) is `ready` again.
   * Returns how many rows changed.
   */
  async markMissing(): Promise<number> {
    const rows = await this.db.select().from(signageMedia).where(inArray(signageMedia.status, ["ready", "missing"]));
    const { client, bucket } = getS3();
    let n = 0;
    for (const r of rows) {
      if (!r.storageKey) continue;
      let present = true;
      try {
        await client.statObject(bucket, r.storageKey);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // Only a definite "not there": a storage outage must not mark the whole library missing.
        if (code !== "NotFound" && code !== "NoSuchKey" && code !== "NoSuchObject") continue;
        present = false;
      }
      if (!present && r.status === "ready") {
        await this.db.update(signageMedia).set({ status: "missing", error: "The file is not in storage (restored from a backup without signage media): upload it again.", updatedAt: new Date() }).where(and(eq(signageMedia.id, r.id), eq(signageMedia.status, "ready")));
        n++;
      } else if (present && r.status === "missing") {
        await this.db.update(signageMedia).set({ status: "ready", error: null, updatedAt: new Date() }).where(and(eq(signageMedia.id, r.id), eq(signageMedia.status, "missing")));
        n++;
      }
    }
    if (n) {
      await this.content.markDirty();
      this.content.searchChanged();
    }
    return n;
  }
}

export function contentTypeFor(r: { kind: string | null; storageKey: string | null }): string {
  if (r.kind === "video") return "video/mp4";
  return r.storageKey?.endsWith(".png") ? "image/png" : "image/jpeg";
}
