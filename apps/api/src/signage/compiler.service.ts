import { createHash } from "node:crypto";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  compileManifest,
  manifestContent,
  manifestEntryAt,
  manifestPowerAt,
  resolveAt,
  startOfDayInZone,
  zonedParts,
  type CompileInput,
  type CompileMedia,
  type CompilePlaylist,
  type SignageManifest,
  type SignageMediaKind,
  type SignageMediaStatus,
  type SignageOrientation,
  type SignagePreview,
  type SignageDeviceStatus,
  type SignageScreen,
  type SignageTargetType,
  type SignageTimelineEntry,
  type SignageTvControl,
  type SignageTvInput,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { signageManifests, signageMedia, signageOverrides, signagePlaylistItems, signagePlaylists, signagePowerSchedules, signageSchedules, signageScreens } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { SignageService, type ScreenRow } from "./signage.service";
import { SIGNAGE_ONLINE_MS } from "./constants";

/** The hour (site time) after which a manifest compiled before today is compiled again, extending its 14 days. */
const NIGHTLY_HOUR = 3;

export interface LoadedContent {
  playlists: Record<string, CompilePlaylist>;
  media: Record<string, CompileMedia>;
  schedules: CompileInput["schedules"];
  overrides: CompileInput["overrides"];
  power: CompileInput["power"];
  playlistNames: Map<string, string>;
  mediaNames: Map<string, string>;
}

/**
 * Compiles each screen's manifest (docs/signage.md section 9) with the pure `compileManifest`, keeps the last 5 per screen,
 * and answers the preview and timeline questions with the same rules. The `signage-compile` job runs every 5 s on one node
 * and compiles the screens marked dirty, plus every screen once a day after 03:00 site time. A manifest gets a new version
 * only when its content changed, so marking every screen dirty on each edit costs nothing on the Pis.
 */
@Injectable()
export class SignageCompiler implements OnModuleInit {
  private readonly logger = new Logger(SignageCompiler.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: ClusterJobs,
    private readonly content: SignageService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "signage-compile", everyMs: 5_000, initialDelayMs: 15_000, schedule: "fixed-delay", run: () => this.tick() });
  }

  async load(): Promise<LoadedContent> {
    const [pls, items, media, schedules, overrides, power] = await Promise.all([
      this.db.select().from(signagePlaylists),
      this.db.select().from(signagePlaylistItems).orderBy(signagePlaylistItems.position),
      this.db.select().from(signageMedia),
      this.db.select().from(signageSchedules),
      this.db.select().from(signageOverrides).where(sql`${signageOverrides.endsAt} > now() - INTERVAL '1 day'`),
      this.db.select().from(signagePowerSchedules),
    ]);
    const playlists: Record<string, CompilePlaylist> = {};
    for (const p of pls) playlists[p.id] = { id: p.id, name: p.name, defaultImageDurationS: p.defaultImageDurationS, items: [] };
    for (const it of items) playlists[it.playlistId]?.items.push({ mediaId: it.mediaId, durationS: it.durationS, enabled: it.enabled, validFrom: it.validFrom, validUntil: it.validUntil });
    return {
      playlists,
      media: Object.fromEntries(media.map((m) => [m.id, { id: m.id, sha256: m.sha256, kind: m.kind as SignageMediaKind | null, durationS: m.durationS, sizeBytes: m.sizeBytes, status: m.status as SignageMediaStatus }])),
      schedules: schedules.map((s) => ({ ...s, targetType: s.targetType as "screen" | "group" })),
      overrides: overrides.map((o) => ({ ...o, targetType: o.targetType as SignageTargetType })),
      power: power.map((p) => ({ ...p, targetType: p.targetType as SignageTargetType })),
      playlistNames: new Map(pls.map((p) => [p.id, p.name])),
      mediaNames: new Map(media.map((m) => [m.sha256 ?? m.id, m.name])),
    };
  }

  inputFor(screen: ScreenRow, groupIds: string[], c: LoadedContent, timezone: string): CompileInput {
    return {
      screen: {
        id: screen.id,
        name: screen.name,
        groupIds,
        fallbackPlaylistId: screen.fallbackPlaylistId,
        orientation: screen.orientation as SignageOrientation,
        tvControl: screen.tvControl as SignageTvControl,
        rokuIp: screen.rokuIp,
        hdmiInput: screen.hdmiInput,
      },
      playlists: c.playlists,
      media: c.media,
      schedules: c.schedules,
      overrides: c.overrides,
      power: c.power,
      timezone,
    };
  }

  /** One pass of the job. */
  async tick(now: Date = new Date()): Promise<void> {
    const tz = await this.content.zone();
    const p = zonedParts(now, tz);
    const today = startOfDayInZone(now, tz);
    const rows = await this.db.select().from(signageScreens).where(eq(signageScreens.enabled, true));
    const due = rows.filter((s) => s.manifestDirtyAt !== null || !s.manifestCompiledAt || (p.hour >= NIGHTLY_HOUR && s.manifestCompiledAt < today));
    if (!due.length) return;
    const content = await this.load();
    const groupsBy = await this.content.groupIdsByScreen();
    for (const s of due) {
      try {
        await this.compileScreen(s, groupsBy.get(s.id) ?? [], content, tz, now);
      } catch (err) {
        this.logger.warn(`signage compile ${s.name}: ${(err as Error).message}`);
      }
    }
  }

  /** Compile one screen; stores a new version only when the content differs from the newest stored one. */
  async compileScreen(s: ScreenRow, groupIds: string[], content: LoadedContent, tz: string, now: Date): Promise<number> {
    const dirtyAt = s.manifestDirtyAt;
    const from = startOfDayInZone(now, tz);
    const version = (s.manifestVersion ?? 0) + 1;
    const { manifest, warnings } = compileManifest(this.inputFor(s, groupIds, content, tz), { from, version, generatedAt: now });
    const sha = createHash("sha256").update(manifestContent(manifest)).digest("hex");
    const [latest] = await this.db.select({ sha256: signageManifests.sha256, version: signageManifests.version }).from(signageManifests).where(eq(signageManifests.screenId, s.id)).orderBy(desc(signageManifests.version)).limit(1);
    let applied = s.manifestVersion ?? 0;
    if (!latest || latest.sha256 !== sha) {
      const v = Math.max(version, (latest?.version ?? 0) + 1);
      manifest.version = v;
      await this.db.insert(signageManifests).values({ screenId: s.id, version: v, sha256: sha, body: manifest, warnings, builtAt: now }).onConflictDoNothing();
      applied = v;
      // Keep the newest five.
      const old = await this.db.select({ id: signageManifests.id }).from(signageManifests).where(eq(signageManifests.screenId, s.id)).orderBy(desc(signageManifests.version)).offset(5);
      if (old.length) await this.db.delete(signageManifests).where(inArray(signageManifests.id, old.map((o) => o.id)));
    }
    // Clear the flag only if nobody marked the screen again while it was compiled.
    await this.db
      .update(signageScreens)
      .set({ manifestVersion: applied, manifestCompiledAt: now, ...(dirtyAt ? { manifestDirtyAt: null } : {}) })
      .where(and(eq(signageScreens.id, s.id), dirtyAt ? eq(signageScreens.manifestDirtyAt, dirtyAt) : sql`true`));
    return applied;
  }

  async latestManifest(screenId: string): Promise<{ manifest: SignageManifest; warnings: string[]; builtAt: Date; sha256: string } | null> {
    const [m] = await this.db.select().from(signageManifests).where(eq(signageManifests.screenId, screenId)).orderBy(desc(signageManifests.version)).limit(1);
    return m ? { manifest: m.body, warnings: m.warnings, builtAt: m.builtAt, sha256: m.sha256 } : null;
  }

  async latestManifests(screenIds: string[]): Promise<Map<string, SignageManifest>> {
    if (!screenIds.length) return new Map();
    const rows = await this.db
      .select({ screenId: signageManifests.screenId, version: signageManifests.version, body: signageManifests.body })
      .from(signageManifests)
      .innerJoin(signageScreens, and(eq(signageScreens.id, signageManifests.screenId), eq(signageScreens.manifestVersion, signageManifests.version)))
      .where(inArray(signageManifests.screenId, screenIds));
    return new Map(rows.map((r) => [r.screenId, r.body]));
  }

  /** What `screenId` shows at `at`, and why, from the live rows (not the stored manifest). */
  async preview(screenId: string, at: Date): Promise<SignagePreview> {
    const s = await this.content.screenRow(screenId);
    const [content, groupsBy, tz] = await Promise.all([this.load(), this.content.groupIdsByScreen(), this.content.zone()]);
    const r = resolveAt(this.inputFor(s, groupsBy.get(s.id) ?? [], content, tz), at);
    const describe = (source: string) => sourceLabel(source);
    const why = !r.winner
      ? r.candidates.length
        ? "Every rule that applies has nothing to play, so the screen shows the logo slide."
        : "Nothing is scheduled and the screen has no fallback playlist: it shows the logo slide."
      : r.winner.source === "fallback"
        ? "No event or schedule applies at this time, so the screen's fallback playlist plays."
        : `${describe(r.winner.source)} "${r.winner.name}" applies${r.candidates.findIndex((c) => c.source === r.winner!.source) > 0 ? " (rules above it had nothing to play)" : ""}.`;
    return {
      at: at.toISOString(),
      playlistId: r.winner?.playlistId ?? null,
      playlistName: r.winner ? (content.playlistNames.get(r.winner.playlistId) ?? null) : null,
      source: r.winner?.source ?? "logo",
      why,
      candidates: r.candidates.map((c) => ({ source: c.source, name: c.name, playlistName: content.playlistNames.get(c.playlistId) ?? "(deleted)", won: c.source === r.winner?.source, note: c.empty })),
      items: (r.winner?.items ?? []).map((i) => ({ mediaId: i.m, name: content.mediaNames.get(i.m) ?? i.m.slice(0, 12), kind: i.kind, seconds: i.dur })),
      power: r.power,
    };
  }

  /** The resolved timeline between two instants (compiled from the live rows, so it shows unsaved-to-Pi changes too). */
  async timeline(screenId: string, from: Date, to: Date): Promise<{ entries: SignageTimelineEntry[]; power: Array<{ at: string; state: "on" | "off" }>; powerInitial: "on" | "off" | null; warnings: string[] }> {
    const s = await this.content.screenRow(screenId);
    const [content, groupsBy, tz] = await Promise.all([this.load(), this.content.groupIdsByScreen(), this.content.zone()]);
    const days = Math.max(1, Math.min(31, Math.ceil((to.getTime() - from.getTime()) / 86_400_000)));
    const { manifest, warnings } = compileManifest(this.inputFor(s, groupsBy.get(s.id) ?? [], content, tz), { from, version: 0, days });
    const names = await this.sourceNames();
    return {
      entries: manifest.timeline.map((e) => {
        const plId = e.playlist.split("~")[0] ?? null;
        return { start: e.start, end: e.end, playlistId: plId, playlistName: plId ? (content.playlistNames.get(plId) ?? null) : null, source: e.source, sourceName: names.get(e.source) ?? sourceLabel(e.source) };
      }),
      power: manifest.power,
      powerInitial: manifest.powerInitial,
      warnings,
    };
  }

  private async sourceNames(): Promise<Map<string, string>> {
    const [s, o] = await Promise.all([this.db.select({ id: signageSchedules.id, name: signageSchedules.name, t: signageSchedules.targetType }).from(signageSchedules), this.db.select({ id: signageOverrides.id, name: signageOverrides.name }).from(signageOverrides)]);
    const m = new Map<string, string>([["fallback", "Fallback playlist"]]);
    for (const r of s) m.set(`${r.t === "group" ? "group-schedule" : "schedule"}:${r.id}`, r.name);
    for (const r of o) m.set(`override:${r.id}`, r.name);
    return m;
  }

  /** The screens as the UI lists them: what plays now and the power state, from each screen's current manifest. */
  async screenDtos(rows: ScreenRow[]): Promise<SignageScreen[]> {
    const [groupsBy, devices, manifests, locs, content, names] = await Promise.all([
      this.content.groupIdsByScreen(),
      this.content.deviceByScreen(),
      this.latestManifests(rows.map((r) => r.id)),
      this.content.locationNames(rows.map((r) => r.locationId).filter((x): x is string => !!x)),
      this.load(),
      this.sourceNames(),
    ]);
    const now = new Date();
    return rows.map((s) => {
      const m = manifests.get(s.id);
      const entry = m ? manifestEntryAt(m, now) : null;
      const plId = entry?.playlist.split("~")[0] ?? null;
      const power = m ? manifestPowerAt(m, now) : null;
      const d = devices.get(s.id);
      return {
        id: s.id,
        name: s.name,
        locationId: s.locationId,
        locationName: s.locationId ? (locs.get(s.locationId) ?? null) : null,
        orientation: s.orientation as SignageOrientation,
        tvControl: s.tvControl as SignageTvControl,
        rokuIp: s.rokuIp,
        rokuSerial: s.rokuSerial,
        hdmiInput: s.hdmiInput as SignageTvInput | null,
        fallbackPlaylistId: s.fallbackPlaylistId,
        groupIds: groupsBy.get(s.id) ?? [],
        notes: s.notes,
        enabled: s.enabled,
        manifestDirty: s.manifestDirtyAt !== null,
        manifestVersion: s.manifestVersion,
        device: d ? { id: d.id, name: d.name, ip: d.ip, status: d.status as SignageDeviceStatus, online: !!d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() < SIGNAGE_ONLINE_MS, lastSeenAt: d.lastSeenAt?.toISOString() ?? null } : null,
        now: m ? { playlistId: plId, playlistName: plId ? (content.playlistNames.get(plId) ?? null) : null, source: entry ? (names.get(entry.source) ?? sourceLabel(entry.source)) : "Logo slide", until: entry?.end ?? null } : null,
        powerNow: power ?? "unmanaged",
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      };
    });
  }

  /** Screens whose current manifest is newer than what their device has. */
  async staleScreens(): Promise<Array<{ id: string; version: number }>> {
    const rows = await this.db.select({ id: signageScreens.id, version: signageScreens.manifestVersion }).from(signageScreens).where(and(eq(signageScreens.enabled, true), isNotNull(signageScreens.manifestVersion)));
    return rows.map((r) => ({ id: r.id, version: r.version! }));
  }
}

export function sourceLabel(source: string): string {
  if (source.startsWith("override:")) return "The event";
  if (source.startsWith("group-schedule:")) return "The screen group's schedule";
  if (source.startsWith("schedule:")) return "The screen's schedule";
  if (source === "fallback") return "Fallback playlist";
  return "Logo slide";
}
