import { BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Res } from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { PERMISSIONS, createLivestreamSchema, updateLivestreamSchema } from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { Audited } from "../audit/audit.decorator";
import { LivestreamsService } from "./livestreams.service";
import { LivestreamChecker } from "./livestream-checker";

function parse<T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { flatten: () => unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

/** Livestreams (docs/livestreams.md): read = the module's user tier, add/edit/check now = moderator, delete and API keys = admin. */
@Controller("livestreams")
export class LivestreamsController {
  constructor(
    private readonly streams: LivestreamsService,
    private readonly checker: LivestreamChecker,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_READ_ANY)
  list() {
    return this.streams.list();
  }

  @Post()
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_WRITE_ANY)
  @Audited({ action: "livestream.create", resourceType: "livestream" })
  create(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.streams.create(parse(createLivestreamSchema, body), user.id);
  }

  /** The platforms' API keys, tried once (Resi also lists its encoders). Admin tier, like the keys themselves. */
  @Post("platforms/:platform/test")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_ADMIN)
  testPlatform(@Param("platform") platform: string) {
    return this.streams.testPlatform(platform);
  }

  /** The stream form's pickers: groups to alert and monitors to show as the encoder (moderators cannot read either list). */
  @Get("choices")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_WRITE_ANY)
  choices() {
    return this.streams.choices();
  }

  /** Resi's encoders for the stream form's picker (moderators choose one; the keys stay with the admins). */
  @Get("platforms/resi/encoders")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_WRITE_ANY)
  resiEncoders() {
    return this.streams.testPlatform("resi");
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_READ_ANY)
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.streams.get(id);
  }

  @Get(":id/history")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_READ_ANY)
  history(@Param("id", ParseUUIDPipe) id: string, @Query("hours") hours?: string) {
    const h = Math.max(1, Math.min(24 * 30, Number(hours) || 24));
    return this.streams.history(id, h);
  }

  @Get(":id/snapshot")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_READ_ANY)
  async snapshot(@Param("id", ParseUUIDPipe) id: string, @Res() reply: FastifyReply) {
    const snap = await this.streams.snapshot(id);
    if (!snap) throw new NotFoundException("No picture yet");
    void reply
      .header("content-type", "image/jpeg")
      .header("cache-control", "private, no-cache")
      .header("x-content-type-options", "nosniff")
      .header("last-modified", snap.takenAt.toUTCString())
      .send(snap.jpeg);
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_WRITE_ANY)
  @Audited({ action: "livestream.update", resourceType: "livestream", resourceIdFromParams: (p) => p.id ?? null, redactKeys: ["streamUrl"] })
  update(@Param("id", ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.streams.update(id, parse(updateLivestreamSchema, body));
  }

  /** Read the stream now (status and a sample), on this node. Up to a minute; 409 while it is already being read. */
  @Post(":id/check")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_WRITE_ANY)
  @Audited({ action: "livestream.check", resourceType: "livestream", resourceIdFromParams: (p) => p.id ?? null })
  async check(@Param("id", ParseUUIDPipe) id: string) {
    const row = await this.streams.row(id);
    if (!row.enabled) throw new ConflictException("This stream is switched off. Switch it on to check it.");
    if (!(await this.checker.checkNow(id))) throw new ConflictException("This stream is being checked right now. Try again in a moment.");
    return this.streams.get(id);
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.LIVESTREAMS_ADMIN)
  @Audited({ action: "livestream.delete", resourceType: "livestream", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.streams.remove(id);
    return { ok: true };
  }
}
