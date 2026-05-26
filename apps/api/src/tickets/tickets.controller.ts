import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  BadRequestException,
} from "@nestjs/common";
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

@Controller("tickets")
export class TicketsController {
  constructor(
    private readonly tickets: TicketsService,
    private readonly realtime: RealtimeGateway,
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
}
