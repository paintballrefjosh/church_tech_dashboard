import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  compilePlaylist,
  localDate,
  signageRangeProblem,
  type CreateSignageOverrideInput,
  type CreateSignagePlaylistInput,
  type CreateSignagePowerScheduleInput,
  type CreateSignageScheduleInput,
  type CreateSignageScreenInput,
  type SignageMediaKind,
  type SignageMediaStatus,
  type SignageOverride,
  type SignagePlaylist,
  type SignagePlaylistItemInput,
  type SignagePowerSchedule,
  type SignageSchedule,
  type SignageScreenGroup,
  type SignageScreenGroupInput,
  type SignageTargetType,
  type UpdateSignageOverrideInput,
  type UpdateSignagePlaylistInput,
  type UpdateSignagePowerScheduleInput,
  type UpdateSignageScheduleInput,
  type UpdateSignageScreenInput,
} from "@church/shared";
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
 * Signage content (docs/signage.md): playlists, screens, screen groups, schedules, events and power schedules. Every write
 * marks the screens to compile (`markDirty`); with fewer than 30 screens it marks them all, which is cheap because a
 * manifest only gets a new version when its content really changed.
 */
@Injectable()
export class SignageService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly locationsService: LocationsService,
    private readonly delivery: NotificationDeliveryService,
  ) {}

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
    return this.getPlaylist(r!.id);
  }

  async updatePlaylist(id: string, input: UpdateSignagePlaylistInput): Promise<SignagePlaylist> {
    await this.getPlaylist(id);
    const { items, ...rest } = input;
    if (items) await this.checkMediaIds(items);
    await this.db.update(signagePlaylists).set({ ...rest, updatedAt: new Date() }).where(eq(signagePlaylists.id, id));
    if (items) await this.writeItems(id, items);
    await this.markDirty();
    return this.getPlaylist(id);
  }

  async deletePlaylist(id: string): Promise<void> {
    await this.getPlaylist(id);
    const [inUse] = await this.db.select({ n: sql<number>`count(*)` }).from(signageSchedules).where(eq(signageSchedules.playlistId, id));
    const [inEvents] = await this.db.select({ n: sql<number>`count(*)` }).from(signageOverrides).where(and(eq(signageOverrides.playlistId, id), sql`${signageOverrides.endsAt} > now()`));
    if (Number(inUse?.n ?? 0) + Number(inEvents?.n ?? 0) > 0) throw new ConflictException("Schedules or upcoming events still use this playlist. Change or delete them first.");
    await this.db.delete(signagePlaylists).where(eq(signagePlaylists.id, id));
    await this.markDirty();
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
    return { id: g!.id, name: g!.name, description: g!.description, screenCount: 0 };
  }

  async updateGroup(id: string, input: Partial<SignageScreenGroupInput>): Promise<SignageScreenGroup> {
    const res = await this.db.update(signageGroups).set(input).where(eq(signageGroups.id, id)).returning();
    if (!res.length) throw new NotFoundException("Screen group not found");
    return (await this.listGroups()).find((g) => g.id === id)!;
  }

  async deleteGroup(id: string): Promise<void> {
    const res = await this.db.delete(signageGroups).where(eq(signageGroups.id, id)).returning({ id: signageGroups.id });
    if (!res.length) throw new NotFoundException("Screen group not found");
    await this.db.delete(signageSchedules).where(and(eq(signageSchedules.targetType, "group"), eq(signageSchedules.targetId, id)));
    await this.db.delete(signageOverrides).where(and(eq(signageOverrides.targetType, "group"), eq(signageOverrides.targetId, id)));
    await this.db.delete(signagePowerSchedules).where(and(eq(signagePowerSchedules.targetType, "group"), eq(signagePowerSchedules.targetId, id)));
    await this.markDirty();
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
    return r!;
  }

  async updateScreen(id: string, input: UpdateSignageScreenInput): Promise<ScreenRow> {
    await this.screenRow(id);
    await this.checkScreenLinks(input);
    const { groupIds, ...rest } = input;
    await this.db.update(signageScreens).set({ ...rest, updatedAt: new Date(), manifestDirtyAt: new Date() }).where(eq(signageScreens.id, id));
    if (groupIds) await this.setGroups(id, groupIds);
    return this.screenRow(id);
  }

  async deleteScreen(id: string): Promise<void> {
    await this.screenRow(id);
    await this.db.delete(signageScreens).where(eq(signageScreens.id, id));
    await this.db.delete(signageSchedules).where(and(eq(signageSchedules.targetType, "screen"), eq(signageSchedules.targetId, id)));
    await this.db.delete(signageOverrides).where(and(eq(signageOverrides.targetType, "screen"), eq(signageOverrides.targetId, id)));
    await this.db.delete(signagePowerSchedules).where(and(eq(signagePowerSchedules.targetType, "screen"), eq(signagePowerSchedules.targetId, id)));
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

  // ------------------------------------------------------------ schedules

  async listSchedules(): Promise<SignageSchedule[]> {
    const [rows, names, pls] = await Promise.all([this.db.select().from(signageSchedules).orderBy(asc(signageSchedules.name)), this.targetNames(), this.playlistNames()]);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      targetType: r.targetType as "screen" | "group",
      targetId: r.targetId,
      targetName: names.get(r.targetId) ?? "(deleted)",
      playlistId: r.playlistId,
      playlistName: pls.get(r.playlistId) ?? "(deleted)",
      priority: r.priority,
      daysOfWeek: r.daysOfWeek,
      startTime: r.startTime,
      endTime: r.endTime,
      startDate: r.startDate,
      endDate: r.endDate,
      enabled: r.enabled,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createSchedule(input: CreateSignageScheduleInput, userId: string | null): Promise<SignageSchedule> {
    await this.checkTarget(input.targetType, input.targetId);
    await this.getPlaylist(input.playlistId);
    const [r] = await this.db.insert(signageSchedules).values({ ...input, createdBy: userId }).returning();
    await this.markDirty();
    return (await this.listSchedules()).find((s) => s.id === r!.id)!;
  }

  async updateSchedule(id: string, input: UpdateSignageScheduleInput): Promise<SignageSchedule> {
    const [before] = await this.db.select().from(signageSchedules).where(eq(signageSchedules.id, id)).limit(1);
    if (!before) throw new NotFoundException("Schedule not found");
    const merged = { ...before, ...input };
    const problem = signageRangeProblem(merged);
    if (problem) throw new BadRequestException(problem);
    if (input.targetType || input.targetId) await this.checkTarget(merged.targetType as SignageTargetType, merged.targetId);
    if (input.playlistId) await this.getPlaylist(input.playlistId);
    await this.db.update(signageSchedules).set({ ...input, updatedAt: new Date() }).where(eq(signageSchedules.id, id));
    await this.markDirty();
    return (await this.listSchedules()).find((s) => s.id === id)!;
  }

  async deleteSchedule(id: string): Promise<void> {
    const res = await this.db.delete(signageSchedules).where(eq(signageSchedules.id, id)).returning({ id: signageSchedules.id });
    if (!res.length) throw new NotFoundException("Schedule not found");
    await this.markDirty();
  }

  // ------------------------------------------------------------ events (overrides)

  async listOverrides(includeEnded = true): Promise<SignageOverride[]> {
    const where = includeEnded ? undefined : sql`${signageOverrides.endsAt} > now() - INTERVAL '7 days'`;
    const [rows, names, pls] = await Promise.all([this.db.select().from(signageOverrides).where(where).orderBy(asc(signageOverrides.startsAt)), this.targetNames(), this.playlistNames()]);
    const now = Date.now();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      targetType: r.targetType as SignageTargetType,
      targetId: r.targetId,
      targetName: r.targetType === "all" ? "All screens" : (names.get(r.targetId ?? "") ?? "(deleted)"),
      playlistId: r.playlistId,
      playlistName: pls.get(r.playlistId) ?? "(deleted)",
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      priority: r.priority,
      forcePowerOn: r.forcePowerOn,
      state: r.endsAt.getTime() <= now ? "ended" : r.startsAt.getTime() <= now ? "active" : "upcoming",
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async createOverride(input: CreateSignageOverrideInput, userId: string | null): Promise<SignageOverride> {
    await this.checkTarget(input.targetType, input.targetId);
    await this.getPlaylist(input.playlistId);
    const [r] = await this.db
      .insert(signageOverrides)
      .values({ ...input, targetId: input.targetType === "all" ? null : input.targetId, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), createdBy: userId })
      .returning();
    await this.markDirty();
    return (await this.listOverrides()).find((o) => o.id === r!.id)!;
  }

  async updateOverride(id: string, input: UpdateSignageOverrideInput): Promise<SignageOverride> {
    const [before] = await this.db.select().from(signageOverrides).where(eq(signageOverrides.id, id)).limit(1);
    if (!before) throw new NotFoundException("Event not found");
    const merged = { targetType: input.targetType ?? before.targetType, targetId: input.targetId !== undefined ? input.targetId : before.targetId, startsAt: input.startsAt ?? before.startsAt.toISOString(), endsAt: input.endsAt ?? before.endsAt.toISOString() };
    const problem = signageRangeProblem(merged);
    if (problem) throw new BadRequestException(problem);
    await this.checkTarget(merged.targetType as SignageTargetType, merged.targetId);
    if (input.playlistId) await this.getPlaylist(input.playlistId);
    const { startsAt, endsAt, ...rest } = input;
    await this.db
      .update(signageOverrides)
      .set({ ...rest, ...(merged.targetType === "all" ? { targetId: null } : {}), ...(startsAt ? { startsAt: new Date(startsAt) } : {}), ...(endsAt ? { endsAt: new Date(endsAt) } : {}) })
      .where(eq(signageOverrides.id, id));
    await this.markDirty();
    return (await this.listOverrides()).find((o) => o.id === id)!;
  }

  /** "End now": the event stops at once (started ones), or is removed (not started yet). */
  async endOverride(id: string): Promise<SignageOverride | { ok: true }> {
    const [r] = await this.db.select().from(signageOverrides).where(eq(signageOverrides.id, id)).limit(1);
    if (!r) throw new NotFoundException("Event not found");
    if (r.startsAt.getTime() > Date.now()) {
      await this.db.delete(signageOverrides).where(eq(signageOverrides.id, id));
      await this.markDirty();
      return { ok: true };
    }
    await this.db.update(signageOverrides).set({ endsAt: new Date() }).where(and(eq(signageOverrides.id, id), sql`${signageOverrides.endsAt} > now()`));
    await this.markDirty();
    return (await this.listOverrides()).find((o) => o.id === id)!;
  }

  async deleteOverride(id: string): Promise<void> {
    const res = await this.db.delete(signageOverrides).where(eq(signageOverrides.id, id)).returning({ id: signageOverrides.id });
    if (!res.length) throw new NotFoundException("Event not found");
    await this.markDirty();
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
