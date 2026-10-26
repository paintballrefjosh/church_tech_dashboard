import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import {
  LIVESTREAM_ALERT_PROBLEMS,
  LIVESTREAM_LIMITS,
  LIVESTREAM_PLATFORM_INFO,
  alertMarker,
  confirmedProblems,
  describeProblems,
  livestreamSetupProblem,
  monitorScheduleActive,
  monitorScheduleMinutesIn,
  parseMonitorSchedule,
  sampleProblems,
  type LivestreamAccess,
  type LivestreamPlatform,
  type LivestreamProblem,
  type LivestreamState,
  type ScheduleWindow,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { groupMemberships, livestreamChecks, livestreamSnapshots, livestreams, users } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { InfraService } from "../infra/infra.service";
import { SettingsService } from "../settings/settings.service";
import { maintenanceActive } from "../monitors/maintenance";
import { decryptStoredSecret } from "../settings/crypto";
import { deleteInBatches } from "../retention/batched-delete";
import { LivestreamsService, type LivestreamRow } from "./livestreams.service";
import {
  facebookLive,
  looksLikeManifest,
  readLink,
  readPage,
  resiEncoders,
  sampleStream,
  twitchStream,
  youtubeDetails,
  type StatusReading,
} from "./livestream-reader";

const TICK_MS = 10_000;
/** A claimed stream is left alone by other nodes this long (a check with a 30 s sample takes well under it). */
const CLAIM_SEC = 240;
/** Status checks (yt-dlp, a playlist fetch) at once on one node; samples have their own, smaller limit. */
const MAX_STATUS_AT_ONCE = 6;
const RETENTION_DAYS = 30;

/**
 * The `livestream-checks` job (docs/livestreams.md). Every 10 s it starts the streams that are due on this node (the job's
 * leader): a status check on the stream's own clock, and when it is live and its sample is due, a sound-and-picture sample.
 * A stream is CLAIMED with `claimed_until` first, so a node taking over the job, or "Check now" on another node, never
 * reads the same stream twice at once. A bad sample is sampled again `confirmAfterSec` later, and only a problem both show
 * is reported (`confirmedProblems`); alerts are claimed through `alerted_problem` (`alertMarker`) before they are sent.
 */
@Injectable()
export class LivestreamChecker implements OnModuleInit {
  private readonly logger = new Logger(LivestreamChecker.name);
  private readonly inFlight = new Set<string>();
  private samplesRunning = 0;
  private readonly sampleWaiters: Array<() => void> = [];

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly streams: LivestreamsService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly delivery: NotificationDeliveryService,
    private readonly infra: InfraService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "livestream-checks", everyMs: TICK_MS, initialDelayMs: 20_000, run: () => this.tick() });
    this.jobs.register({ name: "livestream-prune", everyMs: 6 * 3_600_000, initialDelayMs: 15 * 60_000, run: async () => void (await this.prune()) });
  }

  isRunning(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** One tick: start every due stream that is not already being read, and wait for the ones started here. */
  async tick(now: Date = new Date()): Promise<void> {
    const rows = await this.db.select().from(livestreams).where(eq(livestreams.enabled, true));
    const due = rows.filter((r) => !this.inFlight.has(r.id) && (!r.statusCheckedAt || r.statusCheckedAt.getTime() + r.statusIntervalSec * 1000 <= now.getTime() || (r.live && r.nextSampleAt && r.nextSampleAt <= now)));
    const room = Math.max(0, MAX_STATUS_AT_ONCE - this.inFlight.size);
    const started: Promise<void>[] = [];
    for (const r of due.slice(0, room)) started.push(this.claimAndCheck(r.id, false).then(() => undefined));
    await Promise.all(started);
  }

  /** "Check now", from the stream's page: a status check and a sample straight away. False when it is already being read. */
  async checkNow(id: string): Promise<boolean> {
    if (this.inFlight.has(id)) return false;
    return this.claimAndCheck(id, true);
  }

  private async claimAndCheck(id: string, force: boolean): Promise<boolean> {
    this.inFlight.add(id);
    try {
      const claimed = await this.db
        .update(livestreams)
        .set({ claimedUntil: sql`now() + (${CLAIM_SEC}::int * INTERVAL '1 second')` })
        .where(and(eq(livestreams.id, id), or(isNull(livestreams.claimedUntil), lt(livestreams.claimedUntil, sql`now()`))))
        .returning();
      if (claimed.length === 0) return false;
      try {
        await this.check(claimed[0]!, force);
      } catch (err) {
        this.logger.warn(`livestream ${id}: ${(err as Error).message}`);
        await this.db.update(livestreams).set({ lastError: `The check failed: ${(err as Error).message}`.slice(0, 500), statusCheckedAt: new Date() }).where(eq(livestreams.id, id));
      } finally {
        await this.db.update(livestreams).set({ claimedUntil: null }).where(eq(livestreams.id, id));
      }
      return true;
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async sampleSlot<T>(fn: () => Promise<T>): Promise<T> {
    const max = Math.max(1, Math.min(4, Number(await this.settings.get("livestreams.max_concurrent_samples")) || 2));
    while (this.samplesRunning >= max) await new Promise<void>((resolve) => this.sampleWaiters.push(resolve));
    this.samplesRunning++;
    try {
      return await fn();
    } finally {
      this.samplesRunning--;
      this.sampleWaiters.shift()?.();
    }
  }

  /** Where the stream is read from: the private link when there is one, else the page. */
  private streamUrl(r: LivestreamRow): string {
    if (r.access === "private" && r.streamUrlEnc) return decryptStoredSecret(r.streamUrlEnc, "private stream link");
    return r.pageUrl;
  }

  /** Is it live: the page or link, with the platform's API added where a key is set (and alone for a private Facebook stream). */
  private async status(r: LivestreamRow): Promise<StatusReading> {
    const keys = await this.streams.platformKeys();
    const platform = r.platform as LivestreamPlatform;
    let url = "";
    try {
      url = this.streamUrl(r);
    } catch (err) {
      return { live: null, viewers: null, title: null, startedAt: null, source: "link", picked: null, error: (err as Error).message, videoId: null };
    }
    if (!url && platform === "facebook" && r.platformRef) {
      if (!keys.facebookToken) return { live: null, viewers: null, title: null, startedAt: null, source: "api", picked: null, error: "A private Facebook stream needs a page token in the Livestreams settings.", videoId: null };
      try {
        const fb = await facebookLive(keys.facebookToken, r.platformRef);
        return { live: fb.live, viewers: fb.viewers, title: fb.title, startedAt: null, source: "api", picked: null, error: null, videoId: null };
      } catch (err) {
        return { live: null, viewers: null, title: null, startedAt: null, source: "api", picked: null, error: `Facebook: ${(err as Error).message}`, videoId: null };
      }
    }
    const byLink = !LIVESTREAM_PLATFORM_INFO[platform].pageResolves || looksLikeManifest(url);
    const reading = byLink ? await readLink(url) : await readPage(url);
    // The platform's API adds the viewer count (and corrects "live" when the page could not be read).
    try {
      if (platform === "youtube" && keys.youtubeKey && reading.videoId && reading.live) {
        const yt = await youtubeDetails(keys.youtubeKey, reading.videoId);
        reading.viewers = yt.viewers ?? reading.viewers;
        reading.startedAt = yt.startedAt ?? reading.startedAt;
      } else if (platform === "twitch" && keys.twitchId && keys.twitchSecret && r.pageUrl) {
        const tw = await twitchStream(keys.twitchId, keys.twitchSecret, r.pageUrl);
        reading.viewers = tw.viewers;
        reading.startedAt = tw.startedAt ?? reading.startedAt;
        reading.title = tw.title ?? reading.title;
        if (reading.live === null) Object.assign(reading, { live: tw.live, source: "api", error: null });
      } else if (platform === "facebook" && keys.facebookToken && r.platformRef) {
        const fb = await facebookLive(keys.facebookToken, r.platformRef);
        reading.viewers = fb.viewers ?? reading.viewers;
        if (reading.live === null) Object.assign(reading, { live: fb.live, source: "api", error: null });
      }
    } catch (err) {
      this.logger.debug(`livestream ${r.id} platform API: ${(err as Error).message}`);
    }
    return reading;
  }

  private async resiStatus(r: LivestreamRow): Promise<string | null> {
    if (r.platform !== "resi" || !r.platformRef) return null;
    const keys = await this.streams.platformKeys();
    if (!keys.resiId || !keys.resiSecret) return null;
    try {
      const enc = (await resiEncoders(keys.resiId, keys.resiSecret)).find((e) => e.id === r.platformRef);
      return enc ? `Resi encoder "${enc.name}"${enc.detail ? `: ${enc.detail}` : " is listed"}` : "Resi does not list the encoder chosen for this stream.";
    } catch (err) {
      return `Resi could not be asked: ${(err as Error).message}`;
    }
  }

  /** One stream: status, a sample when due, the verdict, the history row and the alert. */
  async check(r: LivestreamRow, force: boolean, now: Date = new Date()): Promise<void> {
    const setup = livestreamSetupProblem({ platform: r.platform as LivestreamPlatform, access: r.access as LivestreamAccess, pageUrl: r.pageUrl, hasStreamUrl: !!r.streamUrlEnc, platformRef: r.platformRef });
    if (setup) {
      await this.db.update(livestreams).set({ state: "setup", statusCheckedAt: now, lastError: null }).where(eq(livestreams.id, r.id));
      return;
    }
    let windows: ScheduleWindow[] = [];
    try {
      windows = parseMonitorSchedule(r.schedule);
    } catch {
      windows = [];
    }
    const hasSchedule = windows.length > 0;
    const zone = await this.delivery.zone();
    const inWindow = monitorScheduleActive(windows, now, zone);

    // Outside its hours: nothing is read and nothing is wrong; an alert still open is closed without a notice.
    if (hasSchedule && !inWindow && !force) {
      await this.db
        .update(livestreams)
        .set({ state: "outside_hours", statusCheckedAt: now, nextSampleAt: null, offlineStreak: 0, unreachableStreak: 0, sampleProblems: null, prevSampleProblems: null, problems: [], problemSince: null, alertedProblem: "", lastError: null })
        .where(eq(livestreams.id, r.id));
      return;
    }

    const reading = await this.status(r);
    const platformStatus = await this.resiStatus(r);
    const offlineStreak = reading.live === false ? r.offlineStreak + 1 : 0;
    let unreachableStreak = reading.error ? r.unreachableStreak + 1 : 0;
    let lastSample = r.lastSample;
    let sampled = false;
    let sampleProblemsNow = (r.sampleProblems ?? null) as LivestreamProblem[] | null;
    let prevSampleProblems = (r.prevSampleProblems ?? null) as LivestreamProblem[] | null;
    let nextSampleAt = r.nextSampleAt;
    let sampleError: string | null = null;

    if (reading.live && reading.picked && (force || !r.nextSampleAt || r.nextSampleAt <= now)) {
      const result = await this.sampleSlot(() => sampleStream(reading.picked!, r.sampleSeconds, r.silenceDb));
      sampled = true;
      if (result.sample) {
        const found = sampleProblems(result.sample, { silenceDb: r.silenceDb, checkVideo: r.checkVideo });
        prevSampleProblems = sampleProblemsNow;
        sampleProblemsNow = found;
        lastSample = result.sample;
        if (result.jpeg) {
          const b64 = result.jpeg.toString("base64");
          await this.db
            .insert(livestreamSnapshots)
            .values({ livestreamId: r.id, jpegB64: b64, takenAt: now })
            .onConflictDoUpdate({ target: livestreamSnapshots.livestreamId, set: { jpegB64: b64, takenAt: now } });
        }
        // A new problem is looked at again soon, so a real one is known in half a minute and a blip is forgotten.
        const fresh = found.some((p) => LIVESTREAM_ALERT_PROBLEMS.includes(p) && !(prevSampleProblems ?? []).includes(p));
        nextSampleAt = new Date(now.getTime() + (fresh ? LIVESTREAM_LIMITS.confirmAfterSec : r.sampleIntervalSec) * 1000);
      } else {
        sampleError = result.error;
        unreachableStreak = r.unreachableStreak + 1;
        nextSampleAt = new Date(now.getTime() + LIVESTREAM_LIMITS.confirmAfterSec * 1000);
      }
    }
    if (reading.live !== true) {
      // A stream that is not live has no sound or picture to judge; old samples must not confirm a later one.
      sampleProblemsNow = null;
      prevSampleProblems = null;
      nextSampleAt = null;
    }

    const minutesIn = hasSchedule ? (monitorScheduleMinutesIn(windows, now, zone) ?? -1) : null;
    const problems = confirmedProblems({
      minutesIntoWindow: minutesIn,
      hasSchedule,
      graceMin: r.graceMin,
      live: reading.live,
      offlineStreak,
      lastSampleProblems: sampleProblemsNow,
      previousSampleProblems: prevSampleProblems,
      unreachableStreak,
    });
    const alertable = problems.filter((p) => LIVESTREAM_ALERT_PROBLEMS.includes(p));
    const state: LivestreamState = alertable.length ? "problem" : reading.live === true ? "live" : reading.live === false ? "offline" : "unknown";
    const problemSince = alertable.length ? (r.problemSince ?? now) : null;
    const error = reading.error ?? sampleError;

    await this.db
      .update(livestreams)
      .set({
        statusCheckedAt: now,
        state,
        live: reading.live,
        viewers: reading.viewers,
        liveTitle: reading.title,
        liveStartedAt: reading.live ? (reading.startedAt ?? r.liveStartedAt ?? now) : null,
        source: reading.source,
        platformStatus,
        lastError: error,
        offlineStreak,
        unreachableStreak,
        ...(sampled ? { sampledAt: now, lastSample } : {}),
        sampleProblems: sampleProblemsNow,
        prevSampleProblems,
        nextSampleAt,
        problems,
        problemSince,
      })
      .where(eq(livestreams.id, r.id));

    if (sampled || reading.live !== r.live || error !== r.lastError) {
      const s = sampled && lastSample ? (lastSample as { loudnessLufs?: number | null; peakDb?: number | null }) : null;
      await this.db.insert(livestreamChecks).values({
        livestreamId: r.id,
        ts: now,
        kind: sampled ? "sample" : "status",
        live: reading.live,
        viewers: reading.viewers,
        loudnessLufs: s?.loudnessLufs ?? null,
        peakDb: s?.peakDb ?? null,
        problems: sampled ? (sampleProblemsNow ?? []) : problems,
        error,
      });
    }

    await this.alert(r, problems);
  }

  /** Tell the stream's group (else the monitoring recipients) when the confirmed problems change; claimed first. */
  private async alert(r: LivestreamRow, problems: LivestreamProblem[]): Promise<void> {
    const marker = alertMarker(problems);
    if (marker === r.alertedProblem) return;
    const claimed = await this.db
      .update(livestreams)
      .set({ alertedProblem: marker })
      .where(and(eq(livestreams.id, r.id), eq(livestreams.alertedProblem, r.alertedProblem)))
      .returning({ id: livestreams.id });
    if (claimed.length === 0 || (await maintenanceActive(this.settings))) return;
    const title = marker
      ? `${r.name}: ${describeProblems(problems.filter((p) => LIVESTREAM_ALERT_PROBLEMS.includes(p)))}`
      : `${r.name} is back: live with picture and sound`;
    const body = marker
      ? problems.includes("not_live")
        ? "It should be live by now (its schedule and grace minutes have passed), and it is not."
        : problems.includes("unreachable")
          ? "The stream could not be read three times in a row."
          : "Two samples in a row showed it. Check the encoder, the mixer's feed to it, and the stream's page."
      : "The last check found nothing wrong.";
    if (!marker && !r.alertedProblem) return;
    const recipients = await this.recipients(r);
    if (recipients.length === 0) return;
    await this.notifications.createMany(recipients.map((id) => ({ recipientUserId: id, kind: "livestream.problem", title, body, link: `/livestreams/${r.id}` })));
  }

  private async recipients(r: LivestreamRow): Promise<string[]> {
    if (!r.alertGroupId) return this.infra.monitoringRecipientIds();
    const rows = await this.db
      .selectDistinct({ id: users.id })
      .from(groupMemberships)
      .innerJoin(users, eq(users.id, groupMemberships.userId))
      .where(and(eq(groupMemberships.groupId, r.alertGroupId), eq(users.isActive, true), isNull(users.deletedAt)));
    return rows.map((x) => x.id);
  }

  /** History older than 30 days goes, in batches (portable: no DELETE ... LIMIT). */
  async prune(): Promise<number> {
    return deleteInBatches(async (limit) => {
      const res = await this.db.execute(
        sql`DELETE FROM livestream_checks WHERE id IN (SELECT id FROM livestream_checks WHERE ts < now() - (${RETENTION_DAYS}::int * INTERVAL '1 day') LIMIT ${limit}::int)`,
      );
      return Number((res as { rowCount?: number | null }).rowCount ?? 0);
    });
  }
}
