import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { SIGNAGE_LIMITS, manifestPowerAt } from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import { signageDevices, signageFound, signageMedia, signageSetupRuns, signageStatusSamples } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SettingsService } from "../settings/settings.service";
import { NotificationsService } from "../notifications/notifications.service";
import { maintenanceActive } from "../monitors/maintenance";
import { deleteInBatches } from "../retention/batched-delete";
import { getS3 } from "../attachments/s3.client";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SignageDevices, mapLimit } from "./devices.service";

const POLL_PARALLEL = 8;
const SAMPLES_KEEP_DAYS = 7;
const RUNS_KEEP_DAYS = 90;
const FOUND_KEEP_DAYS = 30;
const UNUSED_MEDIA_KEEP_DAYS = 30;

/**
 * `signage-poll` (60 s): `signage-ctl status` on every set-up Pi, what it says recorded and sampled.
 * `signage-watch` (60 s): a Pi silent for 5 minutes while its screen should be on is an outage (`signage.device_offline`,
 * urgent, to the Signage admins), CLAIMED through `offline_alerted`; a recovery notice when it answers again. Silenced in
 * maintenance mode. `signage-prune` (hourly): samples 7 days, runs 90, found Pis 30 after last seen, failed media uploads.
 */
@Injectable()
export class SignagePoller implements OnModuleInit {
  private readonly logger = new Logger(SignagePoller.name);
  private polling = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly content: SignageService,
    private readonly compiler: SignageCompiler,
    private readonly devices: SignageDevices,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "signage-poll", everyMs: 60_000, initialDelayMs: 30_000, schedule: "fixed-delay", run: () => this.poll() });
    this.jobs.register({ name: "signage-watch", everyMs: 60_000, initialDelayMs: 90_000, run: () => this.watch() });
    this.jobs.register({ name: "signage-prune", everyMs: 3_600_000, initialDelayMs: 300_000, run: () => this.prune().then(() => undefined) });
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.db.select().from(signageDevices).where(and(eq(signageDevices.status, "active"), eq(signageDevices.enabled, true), eq(signageDevices.hostKeyMismatch, false)));
      await mapLimit(rows, POLL_PARALLEL, async (d) => {
        try {
          const st = await this.devices.ctl(d, "status", [], { timeoutMs: 45_000 });
          await this.devices.recordStatus(d, st);
        } catch (err) {
          this.logger.debug(`signage poll ${d.name}: ${(err as Error).message}`);
        }
      });
    } finally {
      this.polling = false;
    }
  }

  async watch(now: Date = new Date()): Promise<void> {
    const rows = await this.db.select().from(signageDevices).where(and(eq(signageDevices.status, "active"), eq(signageDevices.enabled, true)));
    if (!rows.length) return;
    const quiet = await maintenanceActive(this.settings);
    const manifests = await this.compiler.latestManifests(rows.map((r) => r.screenId).filter((x): x is string => !!x));
    let recipients: string[] | null = null;
    const tell = async (title: string, body: string, id: string) => {
      if (quiet) return;
      recipients ??= await this.content.recipientIds(true);
      await this.notifications.createMany(recipients.map((u) => ({ recipientUserId: u, kind: "signage.device_offline", title, body, link: `/signage/devices/${id}` })));
    };
    for (const d of rows) {
      const silentMs = d.lastSeenAt ? now.getTime() - d.lastSeenAt.getTime() : Infinity;
      const m = d.screenId ? manifests.get(d.screenId) : undefined;
      const power = m ? manifestPowerAt(m, now) : null;
      const offline = silentMs >= SIGNAGE_LIMITS.offlineAfterMin * 60_000 && power !== "off";
      if (offline && !d.offlineAlerted) {
        const [claimed] = await this.db.update(signageDevices).set({ offlineAlerted: true }).where(and(eq(signageDevices.id, d.id), eq(signageDevices.offlineAlerted, false))).returning();
        if (claimed) await tell(`Signage Pi ${d.name} is offline`, d.lastSeenAt ? `It has not answered since ${d.lastSeenAt.toISOString()}${d.lastError ? `: ${d.lastError}` : ""}.` : "It has never answered.", d.id);
      } else if (!offline && d.offlineAlerted && silentMs < SIGNAGE_LIMITS.offlineAfterMin * 60_000) {
        const [claimed] = await this.db.update(signageDevices).set({ offlineAlerted: false }).where(and(eq(signageDevices.id, d.id), eq(signageDevices.offlineAlerted, true))).returning();
        if (claimed) await tell(`Signage Pi ${d.name} is back online`, "It answers again.", d.id);
      }
    }
  }

  async prune(now: Date = new Date()): Promise<number> {
    const day = 86_400_000;
    let n = 0;
    const samplesCut = new Date(now.getTime() - SAMPLES_KEEP_DAYS * day);
    n += await deleteInBatches(async (limit) => {
      const gone = await this.db
        .delete(signageStatusSamples)
        .where(inArray(signageStatusSamples.id, this.db.select({ id: signageStatusSamples.id }).from(signageStatusSamples).where(lt(signageStatusSamples.ts, samplesCut)).limit(limit)))
        .returning({ id: signageStatusSamples.id });
      return gone.length;
    });
    const runsCut = new Date(now.getTime() - RUNS_KEEP_DAYS * day);
    n += await deleteInBatches(async (limit) => {
      const gone = await this.db
        .delete(signageSetupRuns)
        .where(inArray(signageSetupRuns.id, this.db.select({ id: signageSetupRuns.id }).from(signageSetupRuns).where(and(isNotNull(signageSetupRuns.finishedAt), lt(signageSetupRuns.finishedAt, runsCut))).limit(limit)))
        .returning({ id: signageSetupRuns.id });
      return gone.length;
    });
    const foundCut = new Date(now.getTime() - FOUND_KEEP_DAYS * day);
    n += (await this.db.delete(signageFound).where(lt(signageFound.lastSeenAt, foundCut)).returning({ id: signageFound.id })).length;
    // A failed conversion nobody uses, a month old: its row and any stored file go.
    const mediaCut = new Date(now.getTime() - UNUSED_MEDIA_KEEP_DAYS * day);
    const failed = await this.db
      .select()
      .from(signageMedia)
      .where(and(eq(signageMedia.status, "failed"), lt(signageMedia.updatedAt, mediaCut), sql`NOT EXISTS (SELECT 1 FROM signage_playlist_items i WHERE i.media_id = ${signageMedia.id})`));
    if (failed.length) {
      const { client, bucket } = getS3();
      for (const r of failed) {
        if (r.uploadKey) await client.removeObject(bucket, r.uploadKey).catch(() => undefined);
        await this.db.delete(signageMedia).where(eq(signageMedia.id, r.id));
        n++;
      }
    }
    return n;
  }
}
