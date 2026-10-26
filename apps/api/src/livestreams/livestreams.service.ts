import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import {
  LIVESTREAM_PLATFORM_INFO,
  SAVED_SECRET,
  livestreamSetupProblem,
  type CreateLivestreamInput,
  type Livestream,
  type LivestreamAccess,
  type LivestreamCheck,
  type LivestreamPlatform,
  type LivestreamPlatformTest,
  type LivestreamProblem,
  type LivestreamSample,
  type LivestreamState,
  type UpdateLivestreamInput,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { groups, livestreamChecks, livestreamSnapshots, livestreams, monitorChecks, monitors } from "../db/schema";
import { encryptSecret } from "../settings/crypto";
import { SettingsService } from "../settings/settings.service";
import { facebookLive, resiEncoders, twitchStream, youtubeDetails } from "./livestream-reader";

export type LivestreamRow = typeof livestreams.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * Livestreams: the list and its settings (docs/livestreams.md). The checking itself is `LivestreamChecker`. The private
 * link is stored encrypted and never returned (`hasStreamUrl`), like a monitor's secret options.
 */
@Injectable()
export class LivestreamsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  async toDto(rows: LivestreamRow[]): Promise<Livestream[]> {
    const groupIds = [...new Set(rows.map((r) => r.alertGroupId).filter((x): x is string => !!x))];
    const monitorIds = [...new Set(rows.map((r) => r.encoderMonitorId).filter((x): x is string => !!x))];
    const groupNames = new Map<string, string>();
    if (groupIds.length) for (const g of await this.db.select({ id: groups.id, name: groups.name }).from(groups).where(inArray(groups.id, groupIds))) groupNames.set(g.id, g.name);
    const encoders = new Map<string, Livestream["encoder"]>();
    if (monitorIds.length) {
      const ms = await this.db.select().from(monitors).where(inArray(monitors.id, monitorIds));
      for (const m of ms) {
        const [last] = await this.db.select({ info: monitorChecks.info }).from(monitorChecks).where(eq(monitorChecks.monitorId, m.id)).orderBy(desc(monitorChecks.ts)).limit(1);
        encoders.set(m.id, { id: m.id, name: m.name, status: m.enabled ? m.status : "disabled", info: last?.info ?? "", checkedAt: iso(m.lastCheckedAt) });
      }
    }
    const snaps = new Map<string, Date>();
    const ids = rows.map((r) => r.id);
    if (ids.length) for (const s of await this.db.select({ id: livestreamSnapshots.livestreamId, at: livestreamSnapshots.takenAt }).from(livestreamSnapshots).where(inArray(livestreamSnapshots.livestreamId, ids))) snaps.set(s.id, s.at);
    return rows.map((r) => {
      const hasStreamUrl = !!r.streamUrlEnc;
      const setupProblem = livestreamSetupProblem({ platform: r.platform as LivestreamPlatform, access: r.access as LivestreamAccess, pageUrl: r.pageUrl, hasStreamUrl, platformRef: r.platformRef });
      const state: LivestreamState = !r.enabled ? "disabled" : setupProblem ? "setup" : (r.state as LivestreamState);
      return {
        id: r.id,
        name: r.name,
        platform: r.platform as LivestreamPlatform,
        access: r.access as LivestreamAccess,
        pageUrl: r.pageUrl,
        hasStreamUrl,
        platformRef: r.platformRef,
        statusIntervalSec: r.statusIntervalSec,
        sampleIntervalSec: r.sampleIntervalSec,
        sampleSeconds: r.sampleSeconds,
        schedule: r.schedule,
        graceMin: r.graceMin,
        silenceDb: r.silenceDb,
        checkVideo: r.checkVideo,
        alertGroupId: r.alertGroupId,
        alertGroupName: r.alertGroupId ? (groupNames.get(r.alertGroupId) ?? null) : null,
        encoderMonitorId: r.encoderMonitorId,
        encoder: r.encoderMonitorId ? (encoders.get(r.encoderMonitorId) ?? null) : null,
        enabled: r.enabled,
        setupProblem,
        state,
        live: r.live,
        liveTitle: r.liveTitle,
        liveStartedAt: iso(r.liveStartedAt),
        viewers: r.viewers,
        source: (r.source as Livestream["source"]) ?? null,
        platformStatus: r.platformStatus,
        statusCheckedAt: iso(r.statusCheckedAt),
        sampledAt: iso(r.sampledAt),
        nextSampleAt: iso(r.nextSampleAt),
        sample: (r.lastSample as LivestreamSample | null) ?? null,
        sampleProblems: (r.sampleProblems ?? []) as LivestreamProblem[],
        problems: (r.problems ?? []) as LivestreamProblem[],
        problemSince: iso(r.problemSince),
        lastError: r.lastError,
        hasSnapshot: snaps.has(r.id),
        snapshotAt: iso(snaps.get(r.id) ?? null),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  async list(): Promise<Livestream[]> {
    return this.toDto(await this.db.select().from(livestreams).orderBy(asc(livestreams.name)));
  }

  async row(id: string): Promise<LivestreamRow> {
    const [r] = await this.db.select().from(livestreams).where(eq(livestreams.id, id)).limit(1);
    if (!r) throw new NotFoundException("Livestream not found");
    return r;
  }

  async get(id: string): Promise<Livestream> {
    return (await this.toDto([await this.row(id)]))[0]!;
  }

  private async checkLinks(input: { alertGroupId?: string | null; encoderMonitorId?: string | null }): Promise<void> {
    if (input.alertGroupId) {
      const [g] = await this.db.select({ id: groups.id }).from(groups).where(eq(groups.id, input.alertGroupId)).limit(1);
      if (!g) throw new BadRequestException("That group does not exist.");
    }
    if (input.encoderMonitorId) {
      const [m] = await this.db.select({ id: monitors.id }).from(monitors).where(eq(monitors.id, input.encoderMonitorId)).limit(1);
      if (!m) throw new BadRequestException("That monitor does not exist.");
    }
  }

  async create(input: CreateLivestreamInput, userId: string | null): Promise<Livestream> {
    await this.checkLinks(input);
    const { streamUrl, ...rest } = input;
    const [r] = await this.db
      .insert(livestreams)
      .values({ ...rest, streamUrlEnc: streamUrl && streamUrl !== SAVED_SECRET ? encryptSecret(streamUrl.trim()) : null, createdBy: userId })
      .returning();
    return this.get(r!.id);
  }

  /**
   * An edit. Anything that changes what is read, or when, starts the readings afresh: the old ones described another stream
   * (or another schedule), and a problem confirmed against them would be wrong. The alert marker is kept, so a problem that
   * is still there is not announced twice, and one that went away is announced as over by the next check.
   */
  async update(id: string, input: UpdateLivestreamInput): Promise<Livestream> {
    const before = await this.row(id);
    await this.checkLinks(input);
    const { streamUrl, ...rest } = input;
    const patch: Partial<typeof livestreams.$inferInsert> = { ...rest, updatedAt: new Date() };
    if (streamUrl === null || streamUrl === "") patch.streamUrlEnc = null;
    else if (typeof streamUrl === "string" && streamUrl !== SAVED_SECRET) patch.streamUrlEnc = encryptSecret(streamUrl.trim());
    const readsDiffer =
      (input.platform !== undefined && input.platform !== before.platform) ||
      (input.access !== undefined && input.access !== before.access) ||
      (input.pageUrl !== undefined && input.pageUrl !== before.pageUrl) ||
      (input.platformRef !== undefined && input.platformRef !== before.platformRef) ||
      patch.streamUrlEnc !== undefined ||
      (input.schedule !== undefined && input.schedule !== before.schedule) ||
      (input.enabled !== undefined && input.enabled !== before.enabled);
    if (readsDiffer) {
      Object.assign(patch, {
        statusCheckedAt: null,
        nextSampleAt: null,
        state: "unknown",
        live: null,
        viewers: null,
        liveTitle: null,
        liveStartedAt: null,
        source: null,
        platformStatus: null,
        lastError: null,
        lastSample: null,
        sampleProblems: null,
        prevSampleProblems: null,
        offlineStreak: 0,
        unreachableStreak: 0,
        problems: null,
        problemSince: null,
      });
    }
    await this.db.update(livestreams).set(patch).where(eq(livestreams.id, id));
    if (readsDiffer) await this.db.delete(livestreamSnapshots).where(eq(livestreamSnapshots.livestreamId, id));
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.db.delete(livestreams).where(eq(livestreams.id, id));
  }

  async snapshot(id: string): Promise<{ jpeg: Buffer; takenAt: Date } | null> {
    const [s] = await this.db.select().from(livestreamSnapshots).where(eq(livestreamSnapshots.livestreamId, id)).limit(1);
    return s ? { jpeg: Buffer.from(s.jpegB64, "base64"), takenAt: s.takenAt } : null;
  }

  async history(id: string, hours: number): Promise<LivestreamCheck[]> {
    await this.row(id);
    const since = new Date(Date.now() - hours * 3_600_000);
    const rows = await this.db
      .select()
      .from(livestreamChecks)
      .where(and(eq(livestreamChecks.livestreamId, id), gte(livestreamChecks.ts, since)))
      .orderBy(asc(livestreamChecks.ts))
      .limit(5000);
    return rows.map((r) => ({
      ts: r.ts.toISOString(),
      kind: r.kind as LivestreamCheck["kind"],
      live: r.live,
      viewers: r.viewers,
      loudnessLufs: r.loudnessLufs,
      peakDb: r.peakDb,
      problems: (r.problems ?? []) as LivestreamProblem[],
      error: r.error,
    }));
  }

  async choices(): Promise<{ groups: Array<{ id: string; name: string }>; monitors: Array<{ id: string; name: string; kind: string }> }> {
    const gs = await this.db.select({ id: groups.id, name: groups.name }).from(groups).orderBy(asc(groups.name));
    const ms = await this.db.select({ id: monitors.id, name: monitors.name, kind: monitors.kind }).from(monitors).orderBy(asc(monitors.name));
    return { groups: gs, monitors: ms };
  }

  /** The platform keys in the settings, decrypted (empty strings when unset). */
  async platformKeys() {
    const s = async (k: string) => String((await this.settings.get(k)) ?? "").trim();
    return {
      youtubeKey: await s("livestreams.youtube_api_key"),
      twitchId: await s("livestreams.twitch_client_id"),
      twitchSecret: await s("livestreams.twitch_client_secret"),
      facebookToken: await s("livestreams.facebook_page_token"),
      resiId: await s("livestreams.resi_client_id"),
      resiSecret: await s("livestreams.resi_client_secret"),
    };
  }

  /** "Test" on the settings page: one read with the saved keys, said plainly. Resi lists the encoders to choose from. */
  async testPlatform(platform: string): Promise<LivestreamPlatformTest> {
    const k = await this.platformKeys();
    const fail = (message: string): LivestreamPlatformTest => ({ ok: false, message, items: [] });
    try {
      switch (platform) {
        case "resi": {
          if (!k.resiId || !k.resiSecret) return fail("Enter the Resi client ID and secret first.");
          const list = await resiEncoders(k.resiId, k.resiSecret);
          return { ok: true, message: `Resi answered: ${list.length} encoder${list.length === 1 ? "" : "s"}.`, items: list.map((e) => ({ id: e.id, name: e.name, detail: e.detail })) };
        }
        case "youtube": {
          if (!k.youtubeKey) return fail("Enter the YouTube API key first.");
          // A long-finished public video: the call only proves the key works.
          await youtubeDetails(k.youtubeKey, "jNQXAC9IVRw");
          return { ok: true, message: "The YouTube key works.", items: [] };
        }
        case "twitch": {
          if (!k.twitchId || !k.twitchSecret) return fail("Enter the Twitch client ID and secret first.");
          await twitchStream(k.twitchId, k.twitchSecret, "https://www.twitch.tv/twitch");
          return { ok: true, message: "The Twitch client works.", items: [] };
        }
        case "facebook": {
          if (!k.facebookToken) return fail("Enter the page token first.");
          const pageIds = (await this.db.select({ ref: livestreams.platformRef }).from(livestreams).where(eq(livestreams.platform, "facebook"))).map((r) => r.ref).filter(Boolean);
          if (!pageIds[0]) return { ok: true, message: "Saved. Add a Facebook stream with its page ID to try the token.", items: [] };
          await facebookLive(k.facebookToken, pageIds[0]);
          return { ok: true, message: "The page token works.", items: [] };
        }
        default:
          return fail(`${LIVESTREAM_PLATFORM_INFO[platform as LivestreamPlatform]?.label ?? platform} has no API to test.`);
      }
    } catch (err) {
      return fail(`That did not work: ${(err as Error).message}`);
    }
  }
}
