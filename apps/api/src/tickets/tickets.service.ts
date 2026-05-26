import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { and, eq, desc, asc, ilike, or, inArray, isNull, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { tickets, ticketComments, users } from "../db/schema";
import {
  PERMISSIONS,
  type CreateTicketInput,
  type UpdateTicketInput,
  type TicketListQuery,
  type CreateCommentInput,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { AttachmentsService } from "../attachments/attachments.service";

/**
 * Tickets visibility rule applied to every read/write:
 *   - tickets:read:any (support_engineer, admin) → see / touch any ticket
 *   - tickets:read:own (user) → see / touch only tickets they created
 *
 * Internal comments add a second layer:
 *   - is_internal=true comments only render for users with tickets:read:any.
 *   - Only users with ticket_comments:write:internal can post them.
 *
 * The service raises ForbiddenException whenever a request tries to widen its
 * scope beyond its permissions (e.g. user trying to update someone else's
 * ticket). NotFoundException is used to avoid disclosing the existence of
 * tickets the caller has no business knowing about.
 */
@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly attachments: AttachmentsService,
  ) {}

  private hasAnyRead(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
  }
  private hasAnyWrite(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_WRITE_ANY);
  }
  private canAssign(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_ASSIGN);
  }
  private canDelete(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_DELETE_ANY);
  }
  private canWriteInternal(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKET_COMMENTS_WRITE_INTERNAL);
  }

  async list(user: AuthenticatedUser, query: TicketListQuery) {
    const conds: SQL[] = [];
    const wantsAll = query.scope === "all";
    if (wantsAll && !this.hasAnyRead(user)) {
      throw new ForbiddenException("Missing tickets:read:any");
    }
    if (!wantsAll) {
      conds.push(eq(tickets.createdByUserId, user.id));
    }

    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status];
      if (statuses.length) conds.push(inArray(tickets.status, statuses));
    }
    if (query.priority) {
      const ps = Array.isArray(query.priority) ? query.priority : [query.priority];
      if (ps.length) conds.push(inArray(tickets.priority, ps));
    }
    if (query.assigned === "me") {
      conds.push(eq(tickets.assignedUserId, user.id));
    } else if (query.assigned === "unassigned") {
      conds.push(isNull(tickets.assignedUserId));
    }
    if (query.q) {
      const like = `%${query.q.replace(/[%_]/g, "\\$&")}%`;
      conds.push(or(ilike(tickets.title, like), ilike(tickets.description, like))!);
    }

    const rows = await this.db
      .select()
      .from(tickets)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(tickets.updatedAt))
      .limit(query.limit);
    return rows;
  }

  async getById(user: AuthenticatedUser, id: string) {
    const [row] = await this.db.select().from(tickets).where(eq(tickets.id, id)).limit(1);
    if (!row) throw new NotFoundException("Ticket not found");
    if (row.createdByUserId !== user.id && !this.hasAnyRead(user)) {
      // Disguise as 404 so we don't leak existence.
      throw new NotFoundException("Ticket not found");
    }
    return row;
  }

  async create(user: AuthenticatedUser, input: CreateTicketInput) {
    const [row] = await this.db
      .insert(tickets)
      .values({
        title: input.title.trim(),
        description: input.description ?? "",
        priority: input.priority,
        createdByUserId: user.id,
        status: "open",
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    return row;
  }

  async update(user: AuthenticatedUser, id: string, input: UpdateTicketInput) {
    const existing = await this.getById(user, id);
    const isOwner = existing.createdByUserId === user.id;
    if (!isOwner && !this.hasAnyWrite(user)) {
      throw new ForbiddenException("Cannot edit another user's ticket");
    }

    // Field-level restrictions for non-staff: owners can edit title/description
    // and close their own ticket, but cannot reassign or set arbitrary statuses.
    if (!this.hasAnyWrite(user)) {
      if (input.assignedUserId !== undefined) {
        throw new ForbiddenException("Missing tickets:assign");
      }
      if (input.status && input.status !== "closed" && input.status !== existing.status) {
        throw new ForbiddenException("Owners can only close their own tickets");
      }
    }
    if (input.assignedUserId !== undefined && !this.canAssign(user)) {
      throw new ForbiddenException("Missing tickets:assign");
    }
    // Validate assignee exists, if set.
    if (input.assignedUserId) {
      const [u] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.assignedUserId))
        .limit(1);
      if (!u) throw new BadRequestException("Assignee user not found");
    }

    const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.assignedUserId !== undefined) patch.assignedUserId = input.assignedUserId;
    if (input.status !== undefined && input.status !== existing.status) {
      patch.status = input.status;
      const now = new Date();
      if (input.status === "resolved" && !existing.resolvedAt) patch.resolvedAt = now;
      if (input.status === "closed" && !existing.closedAt) patch.closedAt = now;
      // Re-opening clears the closed/resolved timestamps so SLAs etc. start fresh.
      if (input.status === "open" || input.status === "in_progress") {
        patch.resolvedAt = null;
        patch.closedAt = null;
      }
    }

    const [row] = await this.db.update(tickets).set(patch).where(eq(tickets.id, id)).returning();
    return row!;
  }

  async delete(user: AuthenticatedUser, id: string) {
    if (!this.canDelete(user)) throw new ForbiddenException("Missing tickets:delete:any");
    // Cascade attachments (MinIO + DB) before dropping the ticket row.
    await this.attachments.deleteAllForParent("ticket", id);
    const [row] = await this.db.delete(tickets).where(eq(tickets.id, id)).returning();
    if (!row) throw new NotFoundException("Ticket not found");
    return row;
  }

  /** Visibility check for attachment routes — throws 404/403 like getById. */
  async assertReadable(user: AuthenticatedUser, id: string): Promise<void> {
    await this.getById(user, id);
  }

  /**
   * Write check for attachment routes. Owners can upload to / delete attachments
   * on their own tickets; tickets:write:any holders can touch anything.
   */
  async assertWritable(user: AuthenticatedUser, id: string): Promise<void> {
    const ticket = await this.getById(user, id);
    if (ticket.createdByUserId === user.id) return;
    if (this.hasAnyWrite(user)) return;
    throw new ForbiddenException("Cannot modify this ticket");
  }

  async listComments(user: AuthenticatedUser, ticketId: string) {
    await this.getById(user, ticketId); // visibility check
    const conds: SQL[] = [eq(ticketComments.ticketId, ticketId)];
    if (!this.hasAnyRead(user)) {
      conds.push(eq(ticketComments.isInternal, false));
    }
    return this.db
      .select()
      .from(ticketComments)
      .where(and(...conds))
      .orderBy(asc(ticketComments.createdAt));
  }

  async addComment(user: AuthenticatedUser, ticketId: string, input: CreateCommentInput) {
    await this.getById(user, ticketId);
    if (input.isInternal && !this.canWriteInternal(user)) {
      throw new ForbiddenException("Missing ticket_comments:write:internal");
    }
    const [row] = await this.db
      .insert(ticketComments)
      .values({
        ticketId,
        authorUserId: user.id,
        body: input.body,
        isInternal: input.isInternal,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    await this.db
      .update(tickets)
      .set({ updatedAt: new Date() })
      .where(eq(tickets.id, ticketId));
    return row;
  }

  async deleteComment(user: AuthenticatedUser, ticketId: string, commentId: string) {
    const [c] = await this.db
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.ticketId, ticketId)))
      .limit(1);
    if (!c) throw new NotFoundException("Comment not found");
    if (c.authorUserId !== user.id && !this.canDelete(user)) {
      throw new ForbiddenException("Cannot delete another user's comment");
    }
    if (c.isInternal && !this.hasAnyRead(user)) {
      throw new NotFoundException("Comment not found");
    }
    await this.db.delete(ticketComments).where(eq(ticketComments.id, commentId));
    return { ok: true };
  }
}
