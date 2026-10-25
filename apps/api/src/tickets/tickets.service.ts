import {
  Injectable,
  Inject,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from "@nestjs/common";
import { and, eq, desc, asc, ilike, or, inArray, isNull, type SQL } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { assets, tickets, ticketComments, users, tagAssignments } from "../db/schema";
import { LocationsService } from "../assets/locations.service";
import {
  PERMISSIONS,
  type CreateTicketInput,
  type UpdateTicketInput,
  type TicketListQuery,
  type CreateCommentInput,
  type TicketStatus,
  statusAfterRequesterReply,
  waitingTransition,
} from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { AttachmentsService } from "../attachments/attachments.service";
import { SearchService } from "../search/search.service";
import { ActivityService } from "../activity/activity.service";

/**
 * Tickets visibility rule applied to every read/write:
 *   - tickets:read:any (moderator/admin tier) → see / touch any ticket
 *   - tickets:read:own (user tier) → see / touch only tickets they created
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
    private readonly search: SearchService,
    private readonly activity: ActivityService,
    private readonly rooms: LocationsService,
  ) {}

  private hasAnyRead(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_READ_ANY);
  }
  private hasAnyWrite(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_ADMIN);
  }
  private canAssign(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_ADMIN);
  }
  private canDelete(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_ADMIN);
  }
  private canWriteInternal(user: AuthenticatedUser): boolean {
    return user.permissions.includes(PERMISSIONS.TICKETS_ADMIN);
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
    if (query.tagId) {
      conds.push(
        inArray(
          tickets.id,
          this.db
            .select({ id: tagAssignments.resourceId })
            .from(tagAssignments)
            .where(
              and(
                eq(tagAssignments.resourceType, "ticket"),
                eq(tagAssignments.tagId, query.tagId),
              ),
            ),
        ),
      );
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

  /** A room or item given for a ticket must exist (who may see the item is the asset routes' business). */
  private async checkPlace(input: { locationId?: string | null; assetId?: string | null }): Promise<void> {
    await this.rooms.check(input.locationId);
    if (input.assetId) {
      const [a] = await this.db.select({ id: assets.id }).from(assets).where(eq(assets.id, input.assetId)).limit(1);
      if (!a) throw new BadRequestException("That item does not exist.");
    }
  }

  async create(user: AuthenticatedUser, input: CreateTicketInput) {
    await this.checkPlace(input);
    const [row] = await this.db
      .insert(tickets)
      .values({
        title: input.title.trim(),
        description: input.description ?? "",
        priority: input.priority,
        createdByUserId: user.id,
        status: "open",
        locationId: input.locationId ?? null,
        assetId: input.assetId ?? null,
      })
      .returning();
    if (!row) throw new Error("Insert failed");
    void this.search.changed("ticket", row.id);
    void this.activity.record({
      actorUserId: user.id,
      action: "ticket.created",
      resourceType: "ticket",
      resourceId: row.id,
      title: `Ticket #${row.number}: ${row.title}`,
      summary: row.description?.slice(0, 200) ?? null,
      link: `/tickets/${row.id}`,
    });
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
        throw new ForbiddenException("Missing tickets:admin");
      }
      if (input.status && input.status !== "closed" && input.status !== existing.status) {
        throw new ForbiddenException("Owners can only close their own tickets");
      }
    }
    if (input.assignedUserId !== undefined && !this.canAssign(user)) {
      throw new ForbiddenException("Missing tickets:admin");
    }
    // Validate assignee exists, if set.
    if (input.assignedUserId) {
      const [u] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, input.assignedUserId), isNull(users.deletedAt)))
        .limit(1);
      if (!u) throw new BadRequestException("Assignee user not found");
    }

    await this.checkPlace(input);
    const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
    if (input.locationId !== undefined) patch.locationId = input.locationId;
    if (input.assetId !== undefined) patch.assetId = input.assetId;
    if (input.title !== undefined) patch.title = input.title.trim();
    if (input.description !== undefined) patch.description = input.description;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.assignedUserId !== undefined) patch.assignedUserId = input.assignedUserId;
    if (input.priority !== undefined && input.priority !== existing.priority) {
      // New targets: the notices sent for the old ones no longer apply.
      patch.responseWarnedAt = null;
      patch.responseBreachedAt = null;
      patch.resolutionWarnedAt = null;
      patch.resolutionBreachedAt = null;
    }
    if (input.status !== undefined && input.status !== existing.status) {
      patch.status = input.status;
      const now = new Date();
      if (input.status === "resolved" && !existing.resolvedAt) patch.resolvedAt = now;
      if (input.status === "closed" && !existing.closedAt) patch.closedAt = now;
      // Re-opening clears the closed/resolved timestamps so SLAs etc. start fresh.
      if (input.status === "open" || input.status === "in_progress" || input.status === "waiting") {
        patch.resolvedAt = null;
        patch.closedAt = null;
        if (existing.status === "resolved" || existing.status === "closed") {
          patch.resolutionWarnedAt = null;
          patch.resolutionBreachedAt = null;
        }
      }
      // Waiting on the requester pauses the SLA clocks; leaving it adds the wait to the total.
      const wait = waitingTransition(
        { status: existing.status as TicketStatus, waitingSince: existing.waitingSince, waitedMs: existing.waitedMs },
        input.status,
        now,
      );
      patch.waitingSince = wait.waitingSince;
      patch.waitedMs = wait.waitedMs;
    }
    // Assigning a ticket counts as staff engagement → stops the SLA response
    // clock. Same for any non-owner status change. Idempotent — once set,
    // never updated.
    const staffEngaged =
      (input.assignedUserId && !existing.assignedUserId) ||
      (input.status && input.status !== existing.status && existing.createdByUserId !== user.id);
    if (staffEngaged && !existing.firstResponseAt) {
      patch.firstResponseAt = new Date();
    }

    const [row] = await this.db.update(tickets).set(patch).where(eq(tickets.id, id)).returning();
    if (row) void this.search.changed("ticket", row.id);

    const actor = user.name ?? user.email;
    if (input.title !== undefined && input.title.trim() !== existing.title) {
      await this.logEvent(id, user, `${actor} changed title from "${existing.title}" to "${input.title.trim()}"`);
    }
    if (input.description !== undefined && input.description !== existing.description) {
      await this.logEvent(id, user, `${actor} edited the description`);
    }
    if (input.status !== undefined && input.status !== existing.status) {
      await this.logEvent(id, user, `${actor} changed status from ${existing.status} to ${input.status}`);
    }
    if (input.priority !== undefined && input.priority !== existing.priority) {
      await this.logEvent(id, user, `${actor} changed priority from ${existing.priority} to ${input.priority}`);
    }
    if (input.assignedUserId !== undefined && input.assignedUserId !== existing.assignedUserId) {
      const names = await this.userLabels([existing.assignedUserId, input.assignedUserId]);
      const from = existing.assignedUserId ? names.get(existing.assignedUserId) ?? "unknown" : "unassigned";
      const to = input.assignedUserId ? names.get(input.assignedUserId) ?? "unknown" : "unassigned";
      await this.logEvent(id, user, `${actor} changed assignee from ${from} to ${to}`);
    }
    return row!;
  }

  async delete(user: AuthenticatedUser, id: string) {
    if (!this.canDelete(user)) throw new ForbiddenException("Missing tickets:admin");
    // Cascade attachments (MinIO + DB) before dropping the ticket row.
    await this.attachments.deleteAllForParent("ticket", id);
    const [row] = await this.db.delete(tickets).where(eq(tickets.id, id)).returning();
    if (!row) throw new NotFoundException("Ticket not found");
    void this.search.changed("ticket", id);
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

  /** Append a system-generated entry to the ticket's comment timeline. */
  async logEvent(ticketId: string, user: AuthenticatedUser, body: string) {
    await this.db.insert(ticketComments).values({
      ticketId,
      authorUserId: user.id,
      body,
      isInternal: false,
      kind: "event",
    });
  }

  /** Log a before/after change to a named set (tags, categories) on a ticket. */
  async logSetChange(
    ticketId: string,
    user: AuthenticatedUser,
    noun: string,
    before: string[],
    after: string[],
  ) {
    const added = after.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !after.includes(n));
    if (added.length === 0 && removed.length === 0) return;
    const parts: string[] = [];
    if (added.length) parts.push(`added ${added.join(", ")}`);
    if (removed.length) parts.push(`removed ${removed.join(", ")}`);
    await this.logEvent(ticketId, user, `${user.name ?? user.email} ${noun}: ${parts.join("; ")}`);
  }

  private async userLabels(ids: (string | null)[]) {
    const real = ids.filter((i): i is string => !!i);
    const map = new Map<string, string>();
    if (real.length === 0) return map;
    const rows = await this.db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, real));
    for (const r of rows) map.set(r.id, r.name ?? r.email);
    return map;
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
    const ticket = await this.getById(user, ticketId);
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
    // Stamp first-response time the first time someone other than the
    // creator engages. That's the canonical SLA "response clock stops" event.
    const isFirstResponse =
      !ticket.firstResponseAt && ticket.createdByUserId !== user.id;
    const patch: Partial<typeof tickets.$inferInsert> = { updatedAt: new Date() };
    if (isFirstResponse) patch.firstResponseAt = new Date();
    // The requester answering a ticket that waits on them puts it back to work (and restarts its SLA clocks).
    const reopenedTo =
      ticket.createdByUserId === user.id && !input.isInternal
        ? statusAfterRequesterReply(ticket.status as TicketStatus, ticket.assignedUserId !== null)
        : (ticket.status as TicketStatus);
    if (reopenedTo !== ticket.status) {
      const now = new Date();
      patch.status = reopenedTo;
      const wait = waitingTransition(
        { status: ticket.status as TicketStatus, waitingSince: ticket.waitingSince, waitedMs: ticket.waitedMs },
        reopenedTo,
        now,
      );
      patch.waitingSince = wait.waitingSince;
      patch.waitedMs = wait.waitedMs;
    }
    await this.db.update(tickets).set(patch).where(eq(tickets.id, ticketId));
    if (reopenedTo !== ticket.status) {
      await this.logEvent(ticketId, user, `${user.name ?? user.email} replied: status changed from ${ticket.status} to ${reopenedTo}`);
      void this.search.changed("ticket", ticketId);
    }
    // Mentions are sent by TicketEvents.commented (with the read check), never here: both used to, so every
    // mention arrived twice.
    return row;
  }

  async deleteComment(user: AuthenticatedUser, ticketId: string, commentId: string) {
    // Someone who can no longer open the ticket cannot change its conversation either (getById throws 404/403).
    await this.getById(user, ticketId);
    const [c] = await this.db
      .select()
      .from(ticketComments)
      .where(and(eq(ticketComments.id, commentId), eq(ticketComments.ticketId, ticketId)))
      .limit(1);
    if (!c) throw new NotFoundException("Comment not found");
    if (c.kind === "event") throw new ForbiddenException("Activity entries cannot be deleted");
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
