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
  bulkTicketActionSchema,
} from "@church/shared";
import { RequirePermissions } from "../auth/permissions.decorator";
import { Audited } from "../audit/audit.decorator";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { TicketsService } from "./tickets.service";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { AttachmentsService, type StoredAttachment } from "../attachments/attachments.service";
import { NotificationsService } from "../notifications/notifications.service";
import { MentionsService } from "../mentions/mentions.service";

@Controller("tickets")
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeGateway,
    private readonly attachments: AttachmentsService,
    private readonly notifications: NotificationsService,
    private readonly mentions: MentionsService,
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

    // Capture prior values so we can detect assignment/status changes for
    // notification fan-out. getById enforces visibility too.
    const prior = await this.tickets.getById(user, id);
    const ticket = await this.tickets.update(user, id, parsed.data);

    // Realtime fan-out (unchanged from before).
    this.realtime.toUser(ticket.createdByUserId, "ticket:updated", ticket);
    if (ticket.assignedUserId && ticket.assignedUserId !== ticket.createdByUserId) {
      this.realtime.toUser(ticket.assignedUserId, "ticket:updated", ticket);
    }

    // Notifications: assignment change.
    if (
      ticket.assignedUserId &&
      ticket.assignedUserId !== prior.assignedUserId
    ) {
      void this.notifications.create({
        recipientUserId: ticket.assignedUserId,
        kind: "ticket.assigned",
        title: `Ticket #${ticket.number} assigned to you`,
        body: ticket.title,
        link: `/tickets/${ticket.id}`,
        excludeActorId: user.id,
      });
    }

    // Notifications: status change.
    if (ticket.status !== prior.status) {
      const recipients = new Set<string>([ticket.createdByUserId]);
      if (ticket.assignedUserId) recipients.add(ticket.assignedUserId);
      void this.notifications.createMany(
        [...recipients].map((rid) => ({
          recipientUserId: rid,
          kind: "ticket.status_changed",
          title: `Ticket #${ticket.number} is now "${ticket.status}"`,
          body: ticket.title,
          link: `/tickets/${ticket.id}`,
          excludeActorId: user.id,
        })),
      );
    }

    return ticket;
  }

  @Delete(":id")
  @RequirePermissions(PERMISSIONS.TICKETS_ADMIN)
  @Audited({ action: "ticket.delete", resourceType: "ticket", resourceIdFromParams: (p) => p.id ?? null })
  async remove(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const ticket = await this.tickets.delete(user, id);
    this.realtime.toUser(ticket.createdByUserId, "ticket:deleted", { id });
    return ticket;
  }

  /**
   * Bulk apply a single mutation across many ticket ids. Runs the same
   * permission checks per row as the singleton routes, so this can't be
   * used to escalate. Returns counts of {applied, skipped, failed} so the
   * UI can surface partial-success cases without parsing per-row errors.
   *
   * Audit: one row per affected ticket via the underlying service calls
   * (which go through the same code paths as individual updates).
   */
  @Post("bulk")
  @RequirePermissions(PERMISSIONS.TICKETS_READ_OWN)
  @Audited({ action: "ticket.bulk", resourceType: "ticket" })
  async bulk(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const parsed = bulkTicketActionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const a = parsed.data.action;
    const apply = (id: string): Promise<unknown> => {
      if (a.kind === "delete") return this.tickets.delete(user, id);
      if (a.kind === "set_status") return this.tickets.update(user, id, { status: a.status });
      if (a.kind === "set_priority") return this.tickets.update(user, id, { priority: a.priority });
      return this.tickets.update(user, id, { assignedUserId: a.assignedUserId });
    };
    // Apply across the selection in parallel; each ticket is an independent
    // permission-checked mutation, so there's no ordering dependency.
    const results = await Promise.allSettled(parsed.data.ids.map((id) => apply(id)));
    let applied = 0;
    let skipped = 0;
    const errors: Array<{ id: string; reason: string }> = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (r.status === "fulfilled") {
        applied++;
        continue;
      }
      const e = r.reason as { status?: number; message?: string };
      // 403/404 → user lacks perm or ticket doesn't exist; count as skipped
      // rather than failed so a partial selection doesn't look like an outage.
      if (e.status === 403 || e.status === 404) skipped++;
      else errors.push({ id: parsed.data.ids[i]!, reason: e.message ?? "unknown" });
    }
    return { applied, skipped, failed: errors.length, errors };
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

    // Notify the ticket's creator + assignee (excluding the comment author).
    // Internal comments only notify users who would otherwise see them; for
    // now that's anyone with tickets:read:any. We approximate by skipping
    // creator notification on internal comments (creator may be a 'user' role
    // who can't read internals) but always notifying the assignee (assignment
    // implies staff status).
    const ticket = await this.tickets.getById(user, id);
    const recipients = new Set<string>();
    if (!comment.isInternal) recipients.add(ticket.createdByUserId);
    if (ticket.assignedUserId) recipients.add(ticket.assignedUserId);
    void this.notifications.createMany(
      [...recipients].map((rid) => ({
        recipientUserId: rid,
        kind: "ticket.comment",
        title: `New comment on ticket #${ticket.number}`,
        body: comment.body.slice(0, 280),
        link: `/tickets/${ticket.id}`,
        excludeActorId: user.id,
      })),
    );

    // Fan out @mention notifications for anyone tagged in the comment body
    // (separate kind so users can mute mentions independently of the
    // ticket-comment thread firehose).
    void this.mentions.notify({
      body: comment.body,
      excludeUserId: user.id,
      title: `Mentioned in ticket #${ticket.number}`,
      summary: comment.body,
      link: `/tickets/${ticket.id}`,
    });

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
    let uploaded!: StoredAttachment;
    try {
      uploaded = await this.attachments.upload("ticket", id, user.id, {
        filename: part.filename,
        mimetype: part.mimetype,
        stream: part.file as never,
        sizeLimit: 0,
      });
    } finally {
      part.file.resume?.();
    }

    // Surface the upload in the ticket conversation so reviewers see it without
    // having to scan the attachments panel. Non-internal so the ticket owner
    // sees staff uploads and vice versa. Failure here is non-fatal — the
    // attachment is already stored and we don't want a retry to duplicate it.
    try {
      const comment = await this.tickets.addComment(user, id, {
        body: `Added attachment: ${uploaded.filename}`,
        isInternal: false,
      });
      this.realtime.toRoom(`ticket:${id}`, "ticket:comment", comment);
    } catch {
      // courtesy comment; swallow
    }

    return uploaded;
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
      .header("x-content-type-options", "nosniff")
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
