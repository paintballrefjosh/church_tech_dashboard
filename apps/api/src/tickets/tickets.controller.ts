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
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PERMISSIONS,
  createTicketSchema,
  updateTicketSchema,
  ticketListQuerySchema,
  createCommentSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { TicketsService } from "./tickets.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { AttachmentsService } from "../attachments/attachments.service";

@Controller("tickets")
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeGateway,
    private readonly attachments: AttachmentsService,
  ) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  async list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    const parsed = ticketListQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.tickets.list(user, parsed.data);
  }

  @Get(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  byId(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.tickets.getById(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TICKETS_WRITE_OWN)
  @Audited({ action: "ticket.create", resourceType: "ticket" })
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = createTicketSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const ticket = await this.tickets.create(user, parsed.data);
    // Broadcast to creator (+ assignee, if you assign on create later).
    this.realtime.toUser(user.id, "ticket:created", ticket);
    return ticket;
  }

  @Patch(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({ action: "ticket.update", resourceType: "ticket", resourceIdFromParams: (p) => p.id ?? null })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = updateTicketSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const ticket = await this.tickets.update(user, id, parsed.data);
    this.realtime.toUser(ticket.createdByUserId, "ticket:updated", ticket);
    if (ticket.assignedUserId && ticket.assignedUserId !== ticket.createdByUserId) {
      this.realtime.toUser(ticket.assignedUserId, "ticket:updated", ticket);
    }
    return ticket;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_DELETE_ANY)
  @Audited({ action: "ticket.delete", resourceType: "ticket", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const ticket = await this.tickets.delete(user, id);
    this.realtime.toUser(ticket.createdByUserId, "ticket:deleted", { id });
    return ticket;
  }

  @Get(":id/comments")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  comments(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.tickets.listComments(user, id);
  }

  @Post(":id/comments")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({
    action: "ticket.comment",
    resourceType: "ticket",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async addComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const parsed = createCommentSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const comment = await this.tickets.addComment(user, id, parsed.data);
    this.realtime.toRoom(`ticket:${id}`, "ticket:comment", comment);
    return comment;
  }

  @Delete(":id/comments/:cid")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({
    action: "ticket.comment.delete",
    resourceType: "ticket",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  removeComment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("cid") cid: string,
  ) {
    return this.tickets.deleteComment(user, id, cid);
  }

  // ---- attachments (Phase 1.5.1) ----

  @Get(":id/attachments")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  async listAttachments(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.tickets.assertReadable(user, id);
    return this.attachments.listByParent("ticket", id);
  }

  @Post(":id/attachments")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({
    action: "ticket.attachment.upload",
    resourceType: "ticket",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async uploadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Req() req: FastifyRequest,
  ) {
    await this.tickets.assertWritable(user, id);
    const part = await (req as FastifyRequest & {
      file: () => Promise<
        { filename: string; mimetype: string; file: NodeJS.ReadableStream } | undefined
      >;
    }).file();
    if (!part) throw new BadRequestException("multipart 'file' field is required");
    try {
      return await this.attachments.upload("ticket", id, user.id, {
        filename: part.filename,
        mimetype: part.mimetype,
        stream: part.file as never,
        sizeLimit: 0,
      });
    } finally {
      part.file.resume?.();
    }
  }

  @Get(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  async downloadAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
    @Res() reply: FastifyReply,
  ) {
    await this.tickets.assertReadable(user, id);
    const { row, storageKey } = await this.attachments.getOne("ticket", id, aid);
    const stream = await this.attachments.openStream(storageKey);
    const disp = row.contentType.startsWith("image/") ? "inline" : "attachment";
    void reply
      .header("content-type", row.contentType)
      .header(
        "content-disposition",
        `${disp}; filename="${encodeURIComponent(row.filename)}"`,
      )
      .header("cache-control", "private, max-age=3600")
      .send(stream);
  }

  @Delete(":id/attachments/:aid")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({
    action: "ticket.attachment.delete",
    resourceType: "ticket",
    resourceIdFromParams: (p) => p.id ?? null,
  })
  async deleteAttachment(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Param("aid") aid: string,
  ) {
    await this.tickets.assertWritable(user, id);
    await this.attachments.delete("ticket", id, aid);
    return { ok: true };
  }
}
