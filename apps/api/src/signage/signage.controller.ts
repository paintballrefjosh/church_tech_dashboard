import { BadRequestException, Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PERMISSIONS,
  SIGNAGE_LIMITS,
  createSignagePlaylistSchema,
  createSignagePowerScheduleSchema,
  createSignageScheduleSchema,
  createSignageScreenSchema,
  signageScreenGroupSchema,
  updateSignageMediaSchema,
  updateSignagePlaylistSchema,
  updateSignagePowerScheduleSchema,
  updateSignageScheduleSchema,
  updateSignageScreenGroupSchema,
  updateSignageScreenSchema,
} from "@lampstand/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { SignageService } from "./signage.service";
import { SignageCompiler } from "./compiler.service";
import { SignageMediaService } from "./media.service";

export function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

const idParam = (p: Record<string, string>) => p.id ?? null;

function parseInstant(v: string | undefined, fallback: Date): Date {
  if (!v) return fallback;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new BadRequestException("Not a date and time");
  return new Date(t);
}

function parseRange(header: string | undefined): { start: number; end?: number } | undefined {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? "");
  if (!m) return undefined;
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
}

/**
 * Signage content (docs/signage.md section 9): media, playlists, screens, screen groups, schedules (one-time and repeating) and power
 * schedules. Reading is the module's user tier, changing content the moderator tier; screens (which TV, which Roku) are
 * the admin tier because they describe equipment.
 */
@Controller("signage")
export class SignageController {
  constructor(
    private readonly content: SignageService,
    private readonly compiler: SignageCompiler,
    private readonly media: SignageMediaService,
  ) {}

  // ------------------------------------------------------------ media

  @Get("media")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  listMedia() {
    return this.media.list();
  }

  /** Multipart field `file`, up to 500 MiB, streamed to the object store and converted in the background. */
  @Post("media")
  @SessionOnly()
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.media.upload", resourceType: "signage_media" })
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    const part = await (req as FastifyRequest & {
      file: (opts?: { limits?: { fileSize?: number } }) => Promise<{ filename: string; mimetype: string; file: NodeJS.ReadableStream & { truncated?: boolean } } | undefined>;
    }).file({ limits: { fileSize: SIGNAGE_LIMITS.maxUploadBytes } });
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.media.upload(part.filename || "Upload", part.mimetype || "", part.file as never, () => part.file.truncated === true, user.id);
    } finally {
      part.file.resume?.();
    }
  }

  @Get("media/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  getMedia(@Param("id", ParseUUIDPipe) id: string) {
    return this.media.get(id);
  }

  @Patch("media/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.media.update", resourceType: "signage_media", resourceIdFromParams: idParam })
  renameMedia(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.media.rename(id, parse(updateSignageMediaSchema, body).name);
  }

  @Delete("media/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.media.delete", resourceType: "signage_media", resourceIdFromParams: idParam })
  async deleteMedia(@Param("id", ParseUUIDPipe) id: string) {
    await this.media.remove(id);
    return { ok: true };
  }

  /** The converted file (what the TVs play), with Range support so the browser can seek a video. */
  @Get("media/:id/file")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async mediaFile(@Param("id", ParseUUIDPipe) id: string, @Headers("range") range: string | undefined, @Res() reply: FastifyReply) {
    return this.sendObject(reply, await this.media.open(id, "file", parseRange(range)), !!parseRange(range));
  }

  @Get("media/:id/thumb")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async mediaThumb(@Param("id", ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    return this.sendObject(reply, await this.media.open(id, "thumb"), false);
  }

  private sendObject(reply: FastifyReply, o: { stream: NodeJS.ReadableStream; size: number; contentType: string; start: number; end: number }, partial: boolean) {
    void reply
      .header("content-type", o.contentType)
      .header("cache-control", "private, max-age=300")
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "bytes")
      .header("content-length", String(o.end - o.start + 1));
    if (partial) void reply.code(206).header("content-range", `bytes ${o.start}-${o.end}/${o.size}`);
    return reply.send(o.stream);
  }

  // ------------------------------------------------------------ playlists

  @Get("playlists")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  listPlaylists() {
    return this.content.listPlaylists();
  }

  @Post("playlists")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.playlist.create", resourceType: "signage_playlist" })
  createPlaylist(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.content.createPlaylist(parse(createSignagePlaylistSchema, body), user.id);
  }

  @Get("playlists/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  getPlaylist(@Param("id", ParseUUIDPipe) id: string) {
    return this.content.getPlaylist(id);
  }

  @Patch("playlists/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.playlist.update", resourceType: "signage_playlist", resourceIdFromParams: idParam })
  updatePlaylist(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.content.updatePlaylist(id, parse(updateSignagePlaylistSchema, body));
  }

  @Delete("playlists/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.playlist.delete", resourceType: "signage_playlist", resourceIdFromParams: idParam })
  async deletePlaylist(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.deletePlaylist(id);
    return { ok: true };
  }

  // ------------------------------------------------------------ screens and screen groups

  @Get("screens")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async listScreens() {
    return this.compiler.screenDtos(await this.content.screenRows());
  }

  @Post("screens")
  @RequirePermissions(PERMISSIONS.SIGNAGE_ADMIN)
  @Audited({ action: "signage.screen.create", resourceType: "signage_screen" })
  async createScreen(@Body() body: unknown) {
    const row = await this.content.createScreen(parse(createSignageScreenSchema, body));
    return (await this.compiler.screenDtos([row]))[0];
  }

  @Get("screens/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async getScreen(@Param("id", ParseUUIDPipe) id: string) {
    return (await this.compiler.screenDtos([await this.content.screenRow(id)]))[0];
  }

  @Patch("screens/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_ADMIN)
  @Audited({ action: "signage.screen.update", resourceType: "signage_screen", resourceIdFromParams: idParam })
  async updateScreen(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    const row = await this.content.updateScreen(id, parse(updateSignageScreenSchema, body));
    return (await this.compiler.screenDtos([row]))[0];
  }

  @Delete("screens/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_ADMIN)
  @Audited({ action: "signage.screen.delete", resourceType: "signage_screen", resourceIdFromParams: idParam })
  async deleteScreen(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.deleteScreen(id);
    return { ok: true };
  }

  /** What the screen shows at `at` (default now) and why: every rule that applied, which one won. */
  @Get("screens/:id/preview")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  preview(@Param("id", ParseUUIDPipe) id: string, @Query("at") at?: string) {
    return this.compiler.preview(id, parseInstant(at, new Date()));
  }

  @Get("screens/:id/timeline")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  timeline(@Param("id", ParseUUIDPipe) id: string, @Query("from") from?: string, @Query("to") to?: string) {
    const f = parseInstant(from, new Date());
    const t = parseInstant(to, new Date(f.getTime() + 7 * 86_400_000));
    if (t <= f) throw new BadRequestException("The end is before the start");
    return this.compiler.timeline(id, f, t);
  }

  /** The manifest the screen's Pi was (or will be) given, with the compiler's warnings. */
  @Get("screens/:id/manifest")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  async manifest(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.screenRow(id);
    return (await this.compiler.latestManifest(id)) ?? { manifest: null, warnings: [], builtAt: null, sha256: null };
  }

  @Get("groups")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  listGroups() {
    return this.content.listGroups();
  }

  @Post("groups")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.group.create", resourceType: "signage_group" })
  createGroup(@Body() body: unknown) {
    return this.content.createGroup(parse(signageScreenGroupSchema, body));
  }

  @Patch("groups/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.group.update", resourceType: "signage_group", resourceIdFromParams: idParam })
  updateGroup(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.content.updateGroup(id, parse(updateSignageScreenGroupSchema, body));
  }

  @Delete("groups/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.group.delete", resourceType: "signage_group", resourceIdFromParams: idParam })
  async deleteGroup(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.deleteGroup(id);
    return { ok: true };
  }

  // ------------------------------------------------------------ schedules (one-time and repeating), power

  @Get("schedules")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  listSchedules() {
    return this.content.listSchedules();
  }

  @Post("schedules")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.schedule.create", resourceType: "signage_schedule" })
  createSchedule(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.content.createSchedule(parse(createSignageScheduleSchema, body), user.id);
  }

  @Patch("schedules/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.schedule.update", resourceType: "signage_schedule", resourceIdFromParams: idParam })
  updateSchedule(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.content.updateSchedule(id, parse(updateSignageScheduleSchema, body));
  }

  @Delete("schedules/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.schedule.delete", resourceType: "signage_schedule", resourceIdFromParams: idParam })
  async deleteSchedule(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.deleteSchedule(id);
    return { ok: true };
  }

  /** "End now" for a one-time entry: its end moves to this moment (one that has not started is removed instead). */
  @Post("schedules/:id/end")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.schedule.end", resourceType: "signage_schedule", resourceIdFromParams: idParam })
  endSchedule(@Param("id", ParseUUIDPipe) id: string) {
    return this.content.endSchedule(id);
  }

  @Get("power")
  @RequirePermissions(PERMISSIONS.SIGNAGE_READ_ANY)
  listPower() {
    return this.content.listPower();
  }

  @Post("power")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.power.create", resourceType: "signage_power" })
  createPower(@Body() body: unknown) {
    return this.content.createPower(parse(createSignagePowerScheduleSchema, body));
  }

  @Patch("power/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.power.update", resourceType: "signage_power", resourceIdFromParams: idParam })
  updatePower(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.content.updatePower(id, parse(updateSignagePowerScheduleSchema, body));
  }

  @Delete("power/:id")
  @RequirePermissions(PERMISSIONS.SIGNAGE_WRITE_ANY)
  @Audited({ action: "signage.power.delete", resourceType: "signage_power", resourceIdFromParams: idParam })
  async deletePower(@Param("id", ParseUUIDPipe) id: string) {
    await this.content.deletePower(id);
    return { ok: true };
  }
}
