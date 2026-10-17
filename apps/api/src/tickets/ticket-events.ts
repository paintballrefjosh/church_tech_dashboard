import { Injectable } from "@nestjs/common";
import type { TicketStatus } from "@church/shared";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { RealtimeGateway } from "../realtime/realtime.gateway";
import { NotificationsService } from "../notifications/notifications.service";
import { MentionsService } from "../mentions/mentions.service";
import type { tickets, ticketComments } from "../db/schema";

type TicketRow = typeof tickets.$inferSelect;
type CommentRow = typeof ticketComments.$inferSelect;

/**
 * What the world is told when a ticket changes. The HTTP routes and the helpdesk mailbox both create tickets and comments,
 * and must tell the same people the same way, so it lives here instead of in the controller.
 */
@Injectable()
export class TicketEvents {
  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly mentions: MentionsService,
  ) {}

  created(ticket: TicketRow): void {
    this.realtime.toUser(ticket.createdByUserId, "ticket:created", ticket);
  }

  /**
   * A comment was added. `statusBefore` is the ticket's status before it: a requester's reply can put a waiting ticket back to
   * work, and open pages and the assignee should see that.
   */
  commented(actor: Pick<AuthenticatedUser, "id">, ticket: TicketRow, comment: CommentRow, statusBefore: TicketStatus | string): void {
    this.realtime.toRoom(`ticket:${ticket.id}`, "ticket:comment", comment);
    if (ticket.status !== statusBefore) {
      this.realtime.toUser(ticket.createdByUserId, "ticket:updated", ticket);
      if (ticket.assignedUserId && ticket.assignedUserId !== ticket.createdByUserId) {
        this.realtime.toUser(ticket.assignedUserId, "ticket:updated", ticket);
      }
    }

    // Notify the ticket's creator + assignee (excluding the comment author). Internal comments only notify the assignee:
    // the creator may be someone who cannot read internal notes, and an assignment implies staff.
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
        excludeActorId: actor.id,
        // A reply to this email comes back as a comment, so only for what the requester may see.
        ...(comment.isInternal ? {} : { ticketNumber: ticket.number }),
      })),
    );

    // Anyone @mentioned (a separate kind, so mentions can be muted apart from the comment firehose).
    void this.mentions.notify({
      body: comment.body,
      excludeUserId: actor.id,
      title: `Mentioned in ticket #${ticket.number}`,
      summary: comment.body,
      link: `/tickets/${ticket.id}`,
    });
  }
}
