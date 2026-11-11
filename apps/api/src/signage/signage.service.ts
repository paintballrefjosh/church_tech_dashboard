import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { SearchService } from "../search/search.service";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  compilePlaylist,
  legacySignagePriority,
  localDate,
  normaliseSignageSchedule,
  signageMomentText,
  signagePriorityLabel,
  signageRangeProblem,
  signageScheduleConflicts,
  signageScheduleProblem,
  type CompileSchedule,
  type CreateSignagePlaylistInput,
  type CreateSignagePowerScheduleInput,
  type CreateSignageScheduleInput,
  type CreateSignageScreenInput,
  type SignageMediaKind,
  type SignageMediaStatus,
  type SignagePlaylist,
  type SignagePlaylistItemInput,
  type SignagePowerSchedule,
  type SignageSchedule,
  type SignageScheduleKind,
  type SignageScheduleRule,
  type SignageScreenGroup,
  type SignageScreenGroupInput,
  type SignageTargetType,
  type UpdateSignagePlaylistInput,
  type UpdateSignagePowerScheduleInput,
  type UpdateSignageScheduleInput,
  type UpdateSignageScreenInput,
} from "@lampstand/shared";
import { DB, type Db } from "../db/db.module";
import {
  groupMemberships,
  groupModuleAccess,
  groups,
  locations,
  signageDevices,
  signageGroups,
  signageMedia,
  signageOverrides,
  signagePlaylistItems,
  signagePlaylists,
  signagePowerSchedules,
  signageSchedules,
  signageScreenGroups,
  signageScreens,
  users,
} from "../db/schema";
import { LocationsService } from "../assets/locations.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";

export type ScreenRow = typeof signageScreens.$inferSelect;

/**
 * Signage content (docs/signage.md): playlists, screens, screen groups, schedules (one-time and repeating) and power schedules. Every write
 * marks the screens to compile (`markDirty`); with fewer than 30 screens it marks them all, which is cheap because a
 * manifest only gets a new version when its content really changed.
 */
@Injectable()
export class SignageService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly locationsService: LocationsService,
    private readonly delivery: NotificationDeliveryService,
    @Optional() private readonly search?: SearchService,
  ) {}

  /** Screens, playlists and media are searchable: refresh this node's index now (the 2-minute reconcile heals the rest). */
  searchChanged(): void {
    this.search?.signageChanged();
  }

  /** Mark screens to be compiled by the `signage-compile` job (all of them when no ids are given). */
  async markDirty(screenIds?: string[]): Promise<void> {
    const set = { manifestDirtyAt: new Date() };
    if (screenIds === undefined) await this.db.update(signageScreens).set(set);
    else if (screenIds.length) await this.db.update(signageScreens).set(set).where(inArray(signageScreens.id, screenIds));
  }

  zone(): Promise<string> {
    return this.delivery.zone();
  }

  // ------------------------------------------------------------ playlists

  private async checkMediaIds(items: SignagePlaylistItemInput[]): Promise<void> {
    const ids = [...new Set(items.map((i) => i.mediaId))];
    if (!ids.length) return;
    const found = await this.db.select({ id: signageMedia.id }).from(signageMedia).where(inArray(signageMedia.id, ids));
    if (found.length !== ids.length) throw new BadRequestException("One of the items points at media that no longer exists.");
  }

  async listPlaylists(): Promise<SignagePlaylist[]> {
    const rows = await this.db.select().from(signagePlaylists).orderBy(asc(signagePlaylists.name));
    return this.playlistDtos(rows);
  }

  async getPlaylist(id: string): Promise<SignagePlaylist> {
    const [r] = await this.db.select().from(signagePlaylists).where(eq(signagePlaylists.id, id)).limit(1);
    if (!r) throw new NotFoundException("Playlist not found");
    return (await this.playlistDtos([r]))[0]!;
  }

  private async playlistDtos(rows: Array<typeof signagePlaylists.$inferSelect>): Promise<SignagePlaylist[]> {
    if (!rows.length) return [];
    const items = await this.db
      .select({ item: signagePlaylistItems, media: signageMedia })
      .from(signagePlaylistItems)
      .innerJoin(signageMedia, eq(signageMedia.id, signagePlaylistItems.mediaId))
      .where(inArray(signagePlaylistItems.playlistId, rows.map((r) => r.id)))
      .orderBy(asc(signagePlaylistItems.position));
    const today = localDate(new Date(), await this.zone());
    return rows.map((r) => {
      const mine = items.filter((x) => x.item.playlistId === r.id);
      const compiled = compilePlaylist(
        { id: r.id, name: r.name, defaultImageDurationS: r.defaultImageDurationS, items: mine.map((x) => ({ mediaId: x.item.mediaId, durationS: x.item.durationS, enabled: x.item.enabled, validFrom: x.item.validFrom, validUntil: x.item.validUntil })) },
        Object.fromEntries(mine.map((x) => [x.media.id, { id: x.media.id, sha256: x.media.sha256, kind: x.media.kind as SignageMediaKind | null, durationS: x.media.durationS, sizeBytes: x.media.sizeBytes, status: x.media.status as SignageMediaStatus }])),
        today,
      );
      const warnings: string[] = [];
      if (compiled.skipped) warnings.push(`${compiled.skipped} item${compiled.skipped === 1 ? " is" : "s are"} not ready (still converting, failed, or the file is missing) and will be skipped.`);
      if (mine.length && !compiled.items.length) warnings.push("Nothing in this playlist plays today: screens fall through to their next rule.");
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        defaultImageDurationS: r.defaultImageDurationS,
        isAdhoc: r.isAdhoc,
        items: mine.map((x) => ({
          id: x.item.id,
          mediaId: x.item.mediaId,
          mediaName: x.media.name,
          mediaKind: x.media.kind as SignageMediaKind | null,
          mediaStatus: x.media.status as SignageMediaStatus,
          mediaDurationS: x.media.durationS,
          hasThumb: !!x.media.thumbKey,
          position: x.item.position,
          durationS: x.item.durationS,
          enabled: x.item.enabled,
          validFrom: x.item.validFrom,
          validUntil: x.item.validUntil,
        })),
        loopSeconds: Math.round(compiled.items.reduce((s, i) => s + i.dur, 0)),
        warnings,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  private async writeItems(playlistId: string, items: SignagePlaylistItemInput[]): Promise<void> {
    await this.db.delete(signagePlaylistItems).where(eq(signagePlaylistItems.playlistId, playlistId));
    if (items.length) {
      await this.db.insert(signagePlaylistItems).values(items.map((it, i) => ({ playlistId, mediaId: it.mediaId, position: i, durationS: it.durationS, enabled: it.enabled, validFrom: it.validFrom, validUntil: it.validUntil })));
    }
  }

  async createPlaylist(input: CreateSignagePlaylistInput, userId: string | null): Promise<SignagePlaylist> {
    await this.checkMediaIds(input.items);
    const [r] = await this.db.insert(signagePlaylists).values({ name: input.name, description: input.description, defaultImageDurationS: input.defaultImageDurationS, isAdhoc: input.isAdhoc, createdBy: userId }).returning();
    await this.writeItems(r!.id, input.items);
    await this.markDirty();
    this.searchChanged();
    return this.getPlaylist(r!.id);
  }

  async updatePlaylist(id: string, input: UpdateSignagePlaylistInput): Promise<SignagePlaylist> {
    await this.getPlaylist(id);
    const { items, ...rest } = input;
    if (items) await this.checkMediaIds(items);
    await this.db.update(signagePlaylists).set({ ...rest, updatedAt: new Date() }).where(eq(signagePlaylists.id, id));
    if (items) await this.writeItems(id, items);
    await this.markDirty();
    this.searchChanged();
    return this.getPlaylist(id);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.getPlaylist(id);
    // One-time entries that are over do not count (they go with the playlist).
    const [inUse] = await this.db
      .select({ n: sql<number>`count(*)` })
      .from(signageSchedules)
      .where(and(eq(signageSchedules.playlistId, id), sql`(${signageSchedules.kind} IS DISTINCT FROM 'once' OR ${signageSchedules.endsAt} > now())`));
    if (Number(inUse?.n ?? 0) > 0) throw new ConflictException("Schedule entries still use this playlist. Change or delete them first.");
    await this.db.delete(signagePlaylists).where(eq(signagePlaylists.id, id));
    await this.markDirty();
    this.searchChanged();
  }

  // ------------------------------------------------------------ screen groups

  async listGroups(): Promise<SignageScreenGroup[]> {
    const rows = await this.db.select().from(signageGroups).orderBy(asc(signageGroups.name));
    const counts = await this.db.select({ groupId: signageScreenGroups.groupId, n: sql<number>`count(*)` }).from(signageScreenGroups).groupBy(signageScreenGroups.groupId);
    const by = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
    return rows.map((g) => ({ id: g.id, name: g.name, description: g.description, screenCount: by.get(g.id) ?? 0 }));
  }

  async createGroup(input: SignageScreenGroupInput): Promise<SignageScreenGroup> {
    const [g] = await this.db.insert(signageGroups).values(input).returning();
    this.searchChanged();
    return { id: g!.id, name: g!.name, description: g!.description, screenCount: 0 };
  }

  async updateGroup(id: string, input: Partial<SignageScreenGroupInput>): Promise<SignageScreenGroup> {
    const res = await this.db.update(signageGroups).set(input).where(eq(signageGroups.id, id)).returning();
    if (!res.length) throw new NotFoundException("Screen group not found");
    this.searchChanged(); // screens are found by their groups' names
    return (await this.listGroups()).find((g) => g.id === id)!;
  }

  async deleteGroup(id: string): Promise<void> {
    const res = await this.db.delete(signageGroups).where(eq(signageGroups.id, id)).returning({ id: signageGroups.id });
    if (!res.length) throw new NotFoundException("Screen group not found");
    await this.db.delete(signageSchedules).where(and(eq(signageSchedules.targetType, "group"), eq(signageSchedules.targetId, id)));
    await this.db.delete(signagePowerSchedules).where(and(eq(signagePowerSchedules.targetType, "group"), eq(signagePowerSchedules.targetId, id)));
    await this.markDirty();
    this.searchChanged();
  }

  // ------------------------------------------------------------ screens

  async screenRows(): Promise<ScreenRow[]> {
    return this.db.select().from(signageScreens).orderBy(asc(signageScreens.name));
  }

  async screenRow(id: string): Promise<ScreenRow> {
    const [r] = await this.db.select().from(signageScreens).where(eq(signageScreens.id, id)).limit(1);
    if (!r) throw new NotFoundException("Screen not found");
    return r;
  }

  async groupIdsByScreen(): Promise<Map<string, string[]>> {
    const rows = await this.db.select().from(signageScreenGroups);
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.screenId, [...(out.get(r.screenId) ?? []), r.groupId]);
    return out;
  }

  async locationNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)];
    if (!uniq.length) return new Map();
    const rows = await this.db.select({ id: locations.id, name: locations.name }).from(locations).where(inArray(locations.id, uniq));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async checkScreenLinks(input: { locationId?: string | null; fallbackPlaylistId?: string | null; groupIds?: string[] }): Promise<void> {
    await this.locationsService.check(input.locationId ?? null);
    if (input.fallbackPlaylistId) await this.getPlaylist(input.fallbackPlaylistId);
    if (input.groupIds?.length) {
      const found = await this.db.select({ id: signageGroups.id }).from(signageGroups).where(inArray(signageGroups.id, input.groupIds));
      if (found.length !== new Set(input.groupIds).size) throw new BadRequestException("One of the screen groups does not exist.");
    }
  }

  private async setGroups(screenId: string, groupIds: string[]): Promise<void> {
    await this.db.delete(signageScreenGroups).where(eq(signageScreenGroups.screenId, screenId));
    const uniq = [...new Set(groupIds)];
    if (uniq.length) await this.db.insert(signageScreenGroups).values(uniq.map((groupId) => ({ screenId, groupId })));
  }

  async createScreen(input: CreateSignageScreenInput): Promise<ScreenRow> {
    await this.checkScreenLinks(input);
    const { groupIds, ...rest } = input;
    const [r] = await this.db.insert(signageScreens).values({ ...rest, manifestDirtyAt: new Date() }).returning();
    await this.setGroups(r!.id, groupIds);
    this.searchChanged();
    return r!;
  }

  async updateScreen(id: string, input: UpdateSignageScreenInput): Promise<ScreenRow> {
    await this.screenRow(id);
    await this.checkScreenLinks(input);
    const { groupIds, ...rest } = input;
    await this.db.update(signageScreens).set({ ...rest, updatedAt: new Date(), manifestDirtyAt: new Date() }).where(eq(signageScreens.id, id));
    if (groupIds) await this.setGroups(id, groupIds);
    this.searchChanged();
    return this.screenRow(id);
  }

  async deleteScreen(id: string): Promise<void> {
    await this.screenRow(id);
    await this.db.delete(signageScreens).where(eq(signageScreens.id, id));
    await this.db.delete(signageSchedules).where(and(eq(signageSchedules.targetType, "screen"), eq(signageSchedules.targetId, id)));
    await this.db.delete(signagePowerSchedules).where(and(eq(signagePowerSchedules.targetType, "screen"), eq(signagePowerSchedules.targetId, id)));
    this.searchChanged();
  }

  /** Names for targets (screens and screen groups) in one read. */
  async targetNames(): Promise<Map<string, string>> {
    const [s, g] = await Promise.all([this.db.select({ id: signageScreens.id, name: signageScreens.name }).from(signageScreens), this.db.select({ id: signageGroups.id, name: signageGroups.name }).from(signageGroups)]);
    return new Map([...s, ...g].map((r) => [r.id, r.name]));
  }

  private async checkTarget(targetType: SignageTargetType, targetId: string | null): Promise<void> {
    if (targetType === "all") return;
    if (!targetId) throw new BadRequestException("Pick a screen or a screen group.");
    const table = targetType === "screen" ? signageScreens : signageGroups;
    const [r] = await this.db.select({ id: table.id }).from(table).where(eq(table.id, targetId)).limit(1);
    if (!r) throw new BadRequestException(targetType === "screen" ? "That screen does not exist." : "That screen group does not exist.");
  }

  private async playlistNames(): Promise<Map<string, string>> {
    const rows = await this.db.select({ id: signagePlaylists.id, name: signagePlaylists.name }).from(signagePlaylists);
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  // ------------------------------------------------------------ schedules (one-time and repeating entries)

  async listSchedules(): Promise<SignageSchedule[]> {
    const [rows, names, pls, tz] = await Promise.all([this.db.select().from(signageSchedules).orderBy(asc(signageSchedules.name)), this.targetNames(), this.playlistNames(), this.zone()]);
    const now = Date.now();
    const today = localDate(now, tz);
    return rows.map((row) => {
      const r = scheduleRowToCompile(row);
      const state: SignageSchedule["state"] =
        r.kind === "once"
          ? r.endsAt && r.endsAt.getTime() <= now
            ? "ended"
            : r.startsAt && r.startsAt.getTime() <= now
              ? "active"
              : "upcoming"
          : r.endDate && r.endDate < today
            ? "ended"
            : null;
      return {
        id: r.id,
        name: r.name,
        kind: r.kind,
        targetType: r.targetType,
        targetId: r.targetId,
        targetName: r.targetType === "all" ? "All screens" : (names.get(r.targetId ?? "") ?? "(deleted)"),
        playlistId: r.playlistId,
        playlistName: pls.get(r.playlistId) ?? "(deleted)",
        priority: r.priority,
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
        daysOfWeek: r.daysOfWeek,
        monthWeeks: r.monthWeeks,
        startTime: r.startTime,
        endTime: r.endTime,
        startDate: r.startDate,
        endDate: r.endDate,
        forcePowerOn: r.forcePowerOn,
        enabled: r.enabled,
        state,
        createdAt: r.createdAt.toISOString(),
      };
    });
  }

  private async scheduleDto(id: string): Promise<SignageSchedule> {
    const s = (await this.listSchedules()).find((x) => x.id === id);
    if (!s) throw new NotFoundException("Schedule entry not found");
    return s;
  }

  /** Refuse an entry that would be on at the same moment, on a common screen, at the same priority as another (409, names it). */
  private async assertNoConflict(id: string | null, name: string, v: SignageScheduleRule & { priority: number; enabled: boolean }): Promise<void> {
    if (!v.enabled) return;
    const [rows, groupsBy, tz] = await Promise.all([this.db.select().from(signageSchedules), this.groupIdsByScreen(), this.zone()]);
    const members = new Map<string, string[]>();
    for (const [screenId, gids] of groupsBy) for (const g of gids) members.set(g, [...(members.get(g) ?? []), screenId]);
    const candidate = scheduleRowToCompile({
      id: id ?? "00000000-0000-0000-0000-000000000000",
      name,
      kind: v.kind,
      targetType: v.targetType,
      targetId: v.targetId,
      playlistId: "",
      priority: v.priority,
      startsAt: v.startsAt ? new Date(v.startsAt) : null,
      endsAt: v.endsAt ? new Date(v.endsAt) : null,
      daysOfWeek: v.daysOfWeek,
      monthWeeks: v.monthWeeks,
      startTime: v.startTime,
      endTime: v.endTime,
      startDate: v.startDate,
      endDate: v.endDate,
      forcePowerOn: false,
      enabled: true,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const found = signageScheduleConflicts(candidate, rows.map(scheduleRowToCompile), members, tz, new Date());
    const first = found[0];
    if (!first) return;
    const more = found.length > 1 ? ` It also overlaps ${found.length - 1} other entr${found.length === 2 ? "y" : "ies"} at that priority.` : "";
    throw new ConflictException(
      `This overlaps "${first.name}" on the same screen at the same priority (${signagePriorityLabel(v.priority)}), first on ${signageMomentText(first.at, tz)}. Pick a different priority for one of them, so it is clear which one shows.${more}`,
    );
  }

  async createSchedule(input: CreateSignageScheduleInput, userId: string | null): Promise<SignageSchedule> {
    const v = normaliseSignageSchedule(input);
    await this.checkTarget(v.targetType, v.targetId);
    await this.getPlaylist(v.playlistId);
    await this.assertNoConflict(null, v.name, v);
    const [r] = await this.db
      .insert(signageSchedules)
      .values({ ...v, startsAt: v.startsAt ? new Date(v.startsAt) : null, endsAt: v.endsAt ? new Date(v.endsAt) : null, createdBy: userId })
      .returning({ id: signageSchedules.id });
    await this.markDirty();
    return this.scheduleDto(r!.id);
  }

  async updateSchedule(id: string, input: UpdateSignageScheduleInput): Promise<SignageSchedule> {
    const before = await this.scheduleDto(id);
    const merged = normaliseSignageSchedule({ ...before, ...input });
    const problem = signageScheduleProblem(merged);
    if (problem) throw new BadRequestException(problem);
    if (input.targetType !== undefined || input.targetId !== undefined) await this.checkTarget(merged.targetType, merged.targetId);
    if (input.playlistId) await this.getPlaylist(input.playlistId);
    await this.assertNoConflict(id, merged.name, merged);
    await this.db
      .update(signageSchedules)
      .set({
        name: merged.name,
        kind: merged.kind,
        targetType: merged.targetType,
        targetId: merged.targetId,
        playlistId: merged.playlistId,
        priority: merged.priority,
        startsAt: merged.startsAt ? new Date(merged.startsAt) : null,
        endsAt: merged.endsAt ? new Date(merged.endsAt) : null,
        daysOfWeek: merged.daysOfWeek,
        monthWeeks: merged.monthWeeks,
        startTime: merged.startTime,
        endTime: merged.endTime,
        startDate: merged.startDate,
        endDate: merged.endDate,
        forcePowerOn: merged.forcePowerOn,
        enabled: merged.enabled,
        updatedAt: new Date(),
      })
      .where(eq(signageSchedules.id, id));
    await this.markDirty();
    return this.scheduleDto(id);
  }

  /** "End now" for a one-time entry: it stops at once (started), or is removed (not started yet). */
  async endSchedule(id: string): Promise<SignageSchedule | { ok: true }> {
    const s = await this.scheduleDto(id);
    if (s.kind !== "once") throw new BadRequestException("Only a one-time entry can be ended now; switch a repeating one off instead.");
    if (s.startsAt && Date.parse(s.startsAt) > Date.now()) {
      await this.db.delete(signageSchedules).where(eq(signageSchedules.id, id));
      await this.markDirty();
      return { ok: true };
    }
    await this.db.update(signageSchedules).set({ endsAt: new Date(), updatedAt: new Date() }).where(and(eq(signageSchedules.id, id), sql`${signageSchedules.endsAt} > now()`));
    await this.markDirty();
    return this.scheduleDto(id);
  }

  async deleteSchedule(id: string): Promise<void> {
    const res = await this.db.delete(signageSchedules).where(eq(signageSchedules.id, id)).returning({ id: signageSchedules.id });
    if (!res.length) throw new NotFoundException("Schedule entry not found");
    await this.markDirty();
  }

  /**
   * Converts rows from before migration 0093 (idempotent, run by the `signage-schedule-adopt` job): old weekly rows get a kind
   * and a 1-5 priority, and each old event becomes a one-time entry with the same id (a conditional write each, so two nodes
   * or a crash halfway are harmless). CockroachDB cannot write a column in the migration that adds it, hence a job.
   */
  async adoptLegacySchedules(): Promise<number> {
    let changed = 0;
    const legacy = await this.db.select({ id: signageSchedules.id, priority: signageSchedules.priority }).from(signageSchedules).where(isNull(signageSchedules.kind));
    for (const r of legacy) {
      const res = await this.db
        .update(signageSchedules)
        .set({ kind: "weekly", priority: legacySignagePriority(r.priority, false) })
        .where(and(eq(signageSchedules.id, r.id), isNull(signageSchedules.kind)))
        .returning({ id: signageSchedules.id });
      changed += res.length;
    }
    const events = await this.db.select().from(signageOverrides);
    for (const o of events) {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(signageSchedules)
          .values({
            id: o.id,
            name: o.name,
            kind: "once",
            targetType: o.targetType,
            targetId: o.targetType === "all" ? null : o.targetId,
            playlistId: o.playlistId,
            priority: legacySignagePriority(o.priority, true),
            startsAt: o.startsAt,
            endsAt: o.endsAt,
            daysOfWeek: [],
            forcePowerOn: o.forcePowerOn,
            enabled: true,
            createdBy: o.createdBy,
            createdAt: o.createdAt,
          })
          .onConflictDoNothing();
        await tx.delete(signageOverrides).where(eq(signageOverrides.id, o.id));
      });
      changed++;
    }
    if (changed) await this.markDirty();
    return changed;
  }

  // ------------------------------------------------------------ power schedules

  async listPower(): Promise<SignagePowerSchedule[]> {
    const [rows, names] = await Promise.all([this.db.select().from(signagePowerSchedules).orderBy(asc(signagePowerSchedules.name)), this.targetNames()]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      targetType: r.targetType as SignageTargetType,
      targetId: r.targetId,
      targetName: r.targetType === "all" ? "All screens" : (names.get(r.targetId ?? "") ?? "(deleted)"),
      daysOfWeek: r.daysOfWeek,
      onTime: r.onTime,
      offTime: r.offTime,
      startDate: r.startDate,
      endDate: r.endDate,
      enabled: r.enabled,
    }));
  }

  async createPower(input: CreateSignagePowerScheduleInput): Promise<SignagePowerSchedule> {
    await this.checkTarget(input.targetType, input.targetId);
    const [r] = await this.db.insert(signagePowerSchedules).values({ ...input, targetId: input.targetType === "all" ? null : input.targetId }).returning();
    await this.markDirty();
    return (await this.listPower()).find((p) => p.id === r!.id)!;
  }

  async updatePower(id: string, input: UpdateSignagePowerScheduleInput): Promise<SignagePowerSchedule> {
    const [before] = await this.db.select().from(signagePowerSchedules).where(eq(signagePowerSchedules.id, id)).limit(1);
    if (!before) throw new NotFoundException("Power schedule not found");
    const merged = { ...before, ...input };
    const problem = signageRangeProblem(merged);
    if (problem) throw new BadRequestException(problem);
    await this.checkTarget(merged.targetType as SignageTargetType, merged.targetId);
    await this.db.update(signagePowerSchedules).set({ ...input, ...(merged.targetType === "all" ? { targetId: null } : {}) }).where(eq(signagePowerSchedules.id, id));
    await this.markDirty();
    return (await this.listPower()).find((p) => p.id === id)!;
  }

  async deletePower(id: string): Promise<void> {
    const res = await this.db.delete(signagePowerSchedules).where(eq(signagePowerSchedules.id, id)).returning({ id: signagePowerSchedules.id });
    if (!res.length) throw new NotFoundException("Power schedule not found");
    await this.markDirty();
  }

  // ------------------------------------------------------------ helpers for other services

  /** Members of the admin group or of any group with the Signage module (any tier): who hears about signage problems. */
  async recipientIds(adminOnly = false): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ id: users.id })
      .from(users)
      .innerJoin(groupMemberships, eq(groupMemberships.userId, users.id))
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .leftJoin(groupModuleAccess, and(eq(groupModuleAccess.groupId, groups.id), eq(groupModuleAccess.moduleKey, "signage"), adminOnly ? eq(groupModuleAccess.tier, "admin") : undefined))
      .where(and(eq(users.isActive, true), isNull(users.deletedAt), or(eq(groups.name, "admin"), isNotNull(groupModuleAccess.groupId))));
    return rows.map((r) => r.id);
  }

  async deviceByScreen(): Promise<Map<string, typeof signageDevices.$inferSelect>> {
    const rows = await this.db.select().from(signageDevices).where(isNotNull(signageDevices.screenId));
    return new Map(rows.map((d) => [d.screenId!, d]));
  }
}

/** A stored row as the compiler and the conflict check read it (rows from before migration 0093 read as weekly, 1-5 priority). */
export function scheduleRowToCompile(r: typeof signageSchedules.$inferSelect): CompileSchedule {
  const legacy = r.kind === null;
  return {
    id: r.id,
    name: r.name,
    kind: (r.kind ?? "weekly") as SignageScheduleKind,
    targetType: r.targetType as SignageTargetType,
    targetId: r.targetType === "all" ? null : r.targetId,
    playlistId: r.playlistId,
    priority: legacy ? legacySignagePriority(r.priority, false) : r.priority,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    daysOfWeek: r.daysOfWeek ?? [],
    monthWeeks: r.monthWeeks ?? null,
    startTime: r.startTime,
    endTime: r.endTime,
    startDate: r.startDate,
    endDate: r.endDate,
    forcePowerOn: r.forcePowerOn,
    enabled: r.enabled,
    createdAt: r.createdAt,
  };
}
