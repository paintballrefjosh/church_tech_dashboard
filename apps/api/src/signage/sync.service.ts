import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { SIGNAGE_KEYS, SIGNAGE_LIMITS, inBulkWindow, parseBulkWindow, zonedParts, type SignageManifest } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { signageDevices, signageMedia, signageScreens } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SignageMediaService } from "./media.service";
import { SignageDevices, mapLimit, type DeviceRow } from "./devices.service";
import { PiSession } from "./pi-ssh";
import { SIGNAGE_ONLINE_MS } from "./constants";

const CLAIM_MIN = 10;
const PARALLEL = 4;
/** Copy speed assumed for a time limit (a Pi 3 on 2.4 GHz Wi-Fi manages about 2 MB/s). */
const MIN_BYTES_PER_S = 256 * 1024;

export interface SyncReport {
  copied: number;
  skipped: Array<{ sha256: string; why: string }>;
  manifestVersion: number | null;
  missing: number;
}

/**
 * `signage-sync` (docs/signage.md section 9): a device whose screen has a newer manifest, or that is still missing files,
 * gets the missing media and then the manifest over ONE SSH session. Copies resume where they stopped (the Pi keeps a
 * partial file and says how far it got). Files over 50 MB wait for the bulk window (00:00-05:00 by default) unless the
 * screen needs them within 24 hours. The manifest goes even while files are missing: the Pi skips what it does not have.
 */
@Injectable()
export class SignageSync implements OnModuleInit {
  private readonly logger = new Logger(SignageSync.name);
  private readonly active = new Set<string>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly content: SignageService,
    private readonly compiler: SignageCompiler,
    private readonly media: SignageMediaService,
    private readonly devices: SignageDevices,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "signage-sync", everyMs: 15_000, initialDelayMs: 25_000, run: () => this.tick() });
  }

  async tick(): Promise<void> {
    if (this.active.size >= PARALLEL) return;
    const rows = await this.db
      .select({ d: signageDevices, wanted: signageScreens.manifestVersion })
      .from(signageDevices)
      .innerJoin(signageScreens, eq(signageScreens.id, signageDevices.screenId))
      .where(and(eq(signageDevices.status, "active"), eq(signageDevices.enabled, true), eq(signageDevices.hostKeyMismatch, false), isNotNull(signageScreens.manifestVersion), or(isNull(signageDevices.syncClaimedUntil), lt(signageDevices.syncClaimedUntil, sql`now()`))));
    const now = Date.now();
    // Start the "content behind" clock when a device first lags, stop it once it has caught up.
    const lagging = rows.filter((r) => r.d.manifestVersionApplied !== r.wanted || (r.d.latest?.missingMedia ?? 0) > 0);
    const caughtUp = rows.filter((r) => r.d.manifestWantedSince && !lagging.includes(r)).map((r) => r.d.id);
    if (caughtUp.length) await this.db.update(signageDevices).set({ manifestWantedSince: null }).where(inArray(signageDevices.id, caughtUp));
    const fresh = lagging.filter((r) => !r.d.manifestWantedSince).map((r) => r.d.id);
    if (fresh.length) await this.db.update(signageDevices).set({ manifestWantedSince: new Date() }).where(inArray(signageDevices.id, fresh));
    const due = lagging.filter((r) => r.d.lastSeenAt && now - r.d.lastSeenAt.getTime() < SIGNAGE_ONLINE_MS && !this.active.has(r.d.id));
    for (const r of due.slice(0, PARALLEL - this.active.size)) {
      const [claimed] = await this.db
        .update(signageDevices)
        .set({ syncClaimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
        .where(and(eq(signageDevices.id, r.d.id), or(isNull(signageDevices.syncClaimedUntil), lt(signageDevices.syncClaimedUntil, sql`now()`))))
        .returning();
      if (!claimed) continue;
      this.active.add(claimed.id);
      void this.syncDevice(claimed, false)
        .catch((err: Error) => this.logger.warn(`signage sync ${claimed.name}: ${err.message}`))
        .finally(() => {
          this.active.delete(claimed.id);
          void this.db.update(signageDevices).set({ syncClaimedUntil: null }).where(eq(signageDevices.id, claimed.id));
        });
    }
  }

  /** "Sync now" from the device page: everything the screen needs, ignoring the bulk window. */
  async syncNow(deviceId: string): Promise<SyncReport> {
    const d = await this.devices.row(deviceId);
    const [claimed] = await this.db
      .update(signageDevices)
      .set({ syncClaimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` })
      .where(and(eq(signageDevices.id, d.id), or(isNull(signageDevices.syncClaimedUntil), lt(signageDevices.syncClaimedUntil, sql`now()`))))
      .returning();
    if (!claimed) return { copied: 0, skipped: [{ sha256: "", why: "a sync of this Pi is already running" }], manifestVersion: d.manifestVersionApplied, missing: d.latest?.missingMedia ?? 0 };
    try {
      return await this.syncDevice(claimed, true);
    } finally {
      await this.db.update(signageDevices).set({ syncClaimedUntil: null }).where(eq(signageDevices.id, claimed.id));
    }
  }

  private async bulkAllowed(): Promise<boolean> {
    const w = parseBulkWindow(String((await this.settings.get(SIGNAGE_KEYS.bulkWindow)) ?? "00:00-05:00")) ?? parseBulkWindow("00:00-05:00")!;
    const p = zonedParts(new Date(), await this.content.zone());
    return inBulkWindow(w, p.hour * 60 + p.minute);
  }

  async syncDevice(d: DeviceRow, force: boolean): Promise<SyncReport> {
    if (!d.screenId) return { copied: 0, skipped: [], manifestVersion: null, missing: 0 };
    const latest = await this.compiler.latestManifest(d.screenId);
    if (!latest) return { copied: 0, skipped: [], manifestVersion: null, missing: 0 };
    const m = latest.manifest;
    const shas = Object.keys(m.media);
    const rows = shas.length ? await this.db.select().from(signageMedia).where(and(inArray(signageMedia.sha256, shas), eq(signageMedia.status, "ready"))) : [];
    const bySha = new Map(rows.map((r) => [r.sha256!, r]));
    const bulk = force || (await this.bulkAllowed());
    const soon = neededSoon(m, Date.now() + 24 * 3_600_000);
    const report: SyncReport = { copied: 0, skipped: [], manifestVersion: null, missing: 0 };
    const s = await PiSession.open(await this.devices.login(d));
    try {
      const listing = await SignageDevices.ctlOn(s, "media-list", [], { timeoutMs: 30_000 });
      const have = (listing.media ?? {}) as Record<string, number>;
      const partial = (listing.partial ?? {}) as Record<string, number>;
      let freeBytes = Number(listing.freeMb ?? 0) * 1024 * 1024;
      for (const sha of shas) {
        if (have[sha] !== undefined) continue;
        const r = bySha.get(sha);
        if (!r?.storageKey || !r.sizeBytes) {
          report.skipped.push({ sha256: sha, why: "not in storage (upload it again)" });
          continue;
        }
        if (r.sizeBytes > SIGNAGE_LIMITS.bulkFileBytes && !bulk && !soon.has(sha)) {
          report.skipped.push({ sha256: sha, why: "large file: waits for the overnight copy window" });
          continue;
        }
        const offset = Math.min(partial[sha] ?? 0, r.sizeBytes);
        if (r.sizeBytes - offset > freeBytes - 200 * 1024 * 1024) {
          report.skipped.push({ sha256: sha, why: "not enough free space on the Pi" });
          continue;
        }
        const src = offset < r.sizeBytes ? await this.media.openKey(r.storageKey, "application/octet-stream", offset > 0 ? { start: offset } : undefined) : null;
        const remaining = r.sizeBytes - offset;
        await this.renewClaim(d.id);
        const put = await SignageDevices.ctlOn(s, "media-put", [sha, String(offset), String(r.sizeBytes)], { stdin: src ? src.stream : Buffer.alloc(0), timeoutMs: Math.max(60_000, (remaining / MIN_BYTES_PER_S) * 1000) });
        if (put.done === true) {
          report.copied++;
          freeBytes -= remaining;
        }
      }
      const out = await SignageDevices.ctlOn(s, "manifest-put", [], { stdin: JSON.stringify(m), timeoutMs: 30_000 });
      report.manifestVersion = Number(out.manifestVersion ?? m.version);
      report.missing = Array.isArray(out.missingMedia) ? out.missingMedia.length : 0;
    } finally {
      s.close();
    }
    const latestStatus = d.latest ? { ...d.latest, manifestVersion: report.manifestVersion, missingMedia: report.missing } : d.latest;
    await this.db
      .update(signageDevices)
      .set({ manifestVersionApplied: report.manifestVersion, latest: latestStatus, lastSeenAt: new Date(), ...(report.missing === 0 ? { manifestWantedSince: null } : {}) })
      .where(eq(signageDevices.id, d.id));
    return report;
  }

  private async renewClaim(id: string): Promise<void> {
    await this.db.update(signageDevices).set({ syncClaimedUntil: sql`now() + (${CLAIM_MIN}::int * INTERVAL '1 minute')` }).where(eq(signageDevices.id, id));
  }

  /** Sync several devices (after a big content change) without waiting for the job. */
  async syncMany(ids: string[]): Promise<void> {
    const rows = await this.db.select().from(signageDevices).where(inArray(signageDevices.id, ids));
    await mapLimit(rows, PARALLEL, (d) => this.syncNow(d.id).catch(() => undefined));
  }
}

/** Media a screen plays before `until` (the fallback playlist always counts: it plays whenever nothing else does). */
export function neededSoon(m: SignageManifest, until: number): Set<string> {
  const out = new Set<string>();
  const add = (key: string | null) => {
    for (const it of (key && m.playlists[key]) || []) out.add(it.m);
  };
  add(m.fallbackPlaylist);
  for (const e of m.timeline) if (Date.parse(e.start) < until && Date.parse(e.end) > Date.now()) add(e.playlist);
  return out;
}
