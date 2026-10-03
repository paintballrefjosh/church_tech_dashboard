import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PERMISSIONS,
  createNoteSchema,
  updateNoteSchema,
  noteListQuerySchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { NotesService } from "./notes.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { AttachmentsService } from "../attachments/attachments.service";

@Controller("notes")
export class NotesController {
  constructor(
    private readonly notes: NotesService,
    private readonly realtime: RealtimeGateway,
    private readonly attachments: AttachmentsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const parsed = noteListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.notes.list(user.id, parsed.data);
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  byId(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.notes.getById(user.id, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({ action: "note.create", resourceType: "note" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createNoteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const note = await this.notes.create(user.id, parsed.data);
    this.realtime.toUser(user.id, "note:created", note);
    return note;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({ action: "note.update", resourceType: "note", resourceIdFromParams: (p) => p.id ?? null })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateNoteSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const note = await this.notes.update(user.id, id, parsed.data);
    this.realtime.toUser(user.id, "note:updated", note);
    return note;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.NOTES_DELETE_OWN)
  @Audited({ action: "note.delete", resourceType: "note", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const note = await this.notes.delete(user.id, id);
    this.realtime.toUser(user.id, "note:deleted", { id });
    return note;
  }

  // ---- attachments ----

  @Get(":id/attachments")
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  async listAttachments(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.notes.assertOwner(user.id, id);
    return this.attachments.listByParent("note", id);
  }

  @Post(":id/attachments")
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({
    action: "note.attachment.upload",
    resourceType: "note",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    await this.notes.assertOwner(user.id, id);
    const part = await (req as FastifyRequest & {
      file: () => Promise<{ filename: string; mimetype: string; file: NodeJS.ReadableStream } | undefined>;
    }).file();
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.attachments.upload("note", id, user.id, {
        filename: part.filename,
        mimetype: part.mimetype,
        stream: part.file as never,
        sizeLimit: 0,
      });
    } finally {
      // Drain the stream if upload short-circuits, so the request finishes cleanly.
      part.file.resume?.();
    }
  }

  @Get(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.NOTES_READ_OWN)
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
    @Res() reply: FastifyReply,
  ) {
    await this.notes.assertOwner(user.id, id);
    const { row, storageKey } = await this.attachments.getOne("note", id, aid);
    const stream = await this.attachments.openStream(storageKey);
    // Inline images so the UI can preview them; everything else downloads.
    // nosniff stops the browser from MIME-sniffing past our declared type,
    // which combined with upload-time magic-byte validation means a file
    // stored as image/png really will be rendered (and only rendered) as one.
    const disp = row.contentType.startsWith("image/") ? "inline" : "attachment";
    void reply
      .header("content-type", row.contentType)
      .header("x-content-type-options", "nosniff")
      .header(
        "content-disposition",
        `${disp}; filename="${encodeURIComponent(row.filename)}"`,
      )
      .header("cache-control", "private, max-age=3600")
      .send(stream);
  }

  @Delete(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.NOTES_WRITE_OWN)
  @Audited({
    action: "note.attachment.delete",
    resourceType: "note",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async deleteAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
  ) {
    await this.notes.assertOwner(user.id, id);
    // 404 to non-existent attachments comes from getOne inside delete().
    try {
      await this.attachments.delete("note", id, aid);
    } catch (err) {
      if (err instanceof NotFoundException) throw err;
      throw err;
    }
    return { ok: true };
  }
}
