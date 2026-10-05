import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  PERMISSIONS,
  backupCreateSchema,
  backupRenameSchema,
  backupScheduleInputSchema,
  backupScheduleUpdateSchema,
  restoreRequestSchema,
} from "@church/shared";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { RequirePermissions } from "../auth/permissions.decorator";
import { SessionOnly } from "../auth/session-only.decorator";
import { Audited } from "../audit/audit.decorator";
import { BackupService } from "./backup.service";

const uuid = z.string().uuid();

function parseId(id: string): string {
  if (!uuid.safeParse(id).success) throw new BadRequestException("Invalid id");
  return id;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
  return parsed.data;
}

const idParam = (p: Record<string, string>): string | null => p.id ?? null;

/** The largest backup file accepted for upload (bytes). Default 5 GiB. */
function maxUploadBytes(): number {
  const n = Number(process.env.BACKUP_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 5 * 1024 * 1024 * 1024;
}

/**
 * Backups and restores of the dashboard's own data (admin > Backups). site:admin only, and a
 * signed-in session only (not an API token): a backup holds password hashes and encrypted
 * secrets, and a restore rewrites everything, so neither may be driven by a token that could
 * outlive its revocation.
 */
@Controller("admin/backups")
@RequirePermissions(PERMISSIONS.SITE_ADMIN)
@SessionOnly()
export class BackupController {
  constructor(private readonly backups: BackupService) {}

  // ---- reads (declared before the `:id` routes so they are not taken for ids) ----

  @Get()
  list() {
    return this.backups.list();
  }

  @Get("storage")
  storage() {
    return this.backups.storage();
  }

  @Get("operations")
  operations(@Query("limit") limit?: string) {
    const n = Number(limit);
    return this.backups.operations(Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20);
  }

  @Get("operations/:id")
  operation(@Param("id") id: string) {
    return this.backups.operation(parseId(id));
  }

  @Get("schedules")
  schedules() {
    return this.backups.listSchedules();
  }

  /**
   * Stream a backup using a link made by POST :id/download-link. The token is a query parameter,
   * not a path segment: it is longer than Fastify's 100 character limit for path parameters.
   */
  @Get("download")
  async download(@CurrentUser() user: AuthenticatedUser, @Query("token") token: string | undefined, @Res() reply: FastifyReply) {
    if (!token) throw new BadRequestException("Missing download token");
    const { stream, filename, size } = await this.backups.openDownload(user.id, token);
    reply
      .header("content-type", "application/gzip")
      .header("content-disposition", `attachment; filename="${filename}"`)
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff");
    if (size !== null) reply.header("content-length", String(size));
    void reply.send(stream);
  }

  // ---- schedules ----

  @Post("schedules")
  @Audited({ action: "backup_schedule.create", resourceType: "backup_schedule" })
  createSchedule(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.backups.createSchedule(user, parse(backupScheduleInputSchema, body));
  }

  @Patch("schedules/:id")
  @Audited({ action: "backup_schedule.update", resourceType: "backup_schedule", resourceIdFromParams: idParam })
  updateSchedule(@Param("id") id: string, @Body() body: unknown) {
    return this.backups.updateSchedule(parseId(id), parse(backupScheduleUpdateSchema, body));
  }

  @Delete("schedules/:id")
  @Audited({ action: "backup_schedule.delete", resourceType: "backup_schedule", resourceIdFromParams: idParam })
  deleteSchedule(@Param("id") id: string) {
    return this.backups.deleteSchedule(parseId(id));
  }

  @Post("schedules/:id/run")
  @HttpCode(202)
  @Audited({ action: "backup_schedule.run", resourceType: "backup_schedule", resourceIdFromParams: idParam })
  runSchedule(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.backups.runScheduleNow(user, parseId(id));
  }

  // ---- backups ----

  @Post()
  @HttpCode(202)
  @Audited({ action: "backup.create", resourceType: "backup" })
  create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.backups.startBackup(user, parse(backupCreateSchema, body));
  }

  /** A backup file from elsewhere (downloaded earlier, or from another installation). Multipart field `file`. */
  @Post("upload")
  @HttpCode(202)
  @Audited({ action: "backup.upload", resourceType: "backup" })
  async upload(@CurrentUser() user: AuthenticatedUser, @Req() req: FastifyRequest) {
    const part = await (req as FastifyRequest & {
      file: (opts?: { limits?: { fileSize?: number } }) => Promise<
        { filename: string; file: NodeJS.ReadableStream & { truncated?: boolean } } | undefined
      >;
    }).file({ limits: { fileSize: maxUploadBytes() } });
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.backups.importUpload(user, part.filename || "Uploaded backup", part.file as never, () => part.file.truncated === true);
    } finally {
      part.file.resume?.();
    }
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.backups.get(parseId(id));
  }

  @Patch(":id")
  @Audited({ action: "backup.rename", resourceType: "backup", resourceIdFromParams: idParam })
  rename(@Param("id") id: string, @Body() body: unknown) {
    return this.backups.rename(parseId(id), parse(backupRenameSchema, body).name);
  }

  @Delete(":id")
  @Audited({ action: "backup.delete", resourceType: "backup", resourceIdFromParams: idParam })
  remove(@Param("id") id: string) {
    return this.backups.delete(parseId(id));
  }

  /** Step one of a download: audited, returns a short-lived link for this person only. */
  @Post(":id/download-link")
  @Audited({ action: "backup.download", resourceType: "backup", resourceIdFromParams: idParam, redactKeys: ["token"] })
  async downloadLink(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const link = await this.backups.createDownloadToken(user.id, parseId(id));
    return { url: `/api/v1/admin/backups/download?token=${encodeURIComponent(link.token)}`, filename: link.filename, expiresAt: link.expiresAt, token: link.token };
  }

  @Post(":id/compare")
  @HttpCode(202)
  @Audited({ action: "backup.compare", resourceType: "backup", resourceIdFromParams: idParam })
  compare(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.backups.startCompare(user, parseId(id));
  }

  @Post(":id/restore")
  @HttpCode(202)
  @Audited({ action: "backup.restore", resourceType: "backup", resourceIdFromParams: idParam })
  restore(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Body() body: unknown) {
    return this.backups.startRestore(user, parseId(id), parse(restoreRequestSchema, body));
  }
}
