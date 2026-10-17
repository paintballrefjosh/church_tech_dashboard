import { z } from "zod";

/**
 * `waiting` = waiting on the requester: staff asked a question and nothing can move until the answer comes. The SLA
 * clocks are paused while a ticket waits (see `ticketSlaStatus`), and the requester's reply puts it back to work.
 */
export const TICKET_STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const ticketSchema = z.object({
  id: z.string().uuid(),
  number: z.number().int().positive(),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000),
  status: z.enum(TICKET_STATUSES),
  priority: z.enum(TICKET_PRIORITIES),
  createdByUserId: z.string().uuid(),
  assignedUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  firstResponseAt: z.string().datetime().nullable(),
  resolvedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  /** Set while the status is `waiting`; the time spent waiting before that is in `waitedMs`. */
  waitingSince: z.string().datetime().nullable().optional(),
  waitedMs: z.number().int().nonnegative().optional(),
});
export type Ticket = z.infer<typeof ticketSchema>;

/**
 * SLA targets per priority (in minutes). 0 disables that clock entirely.
 * Sourced from settings (`tickets.sla.{response_min,resolution_min}.{priority}`).
 * The shared shape lives here so the web UI and api can both read it.
 */
export interface TicketSlaTargets {
  responseMin: number;
  resolutionMin: number;
}
export type TicketSlaMap = Record<TicketPriority, TicketSlaTargets>;

/**
 * Compute SLA status for a ticket, given the target map.
 *   - responseBreached: now > createdAt + responseMin AND firstResponseAt is null
 *   - resolutionBreached: now > createdAt + resolutionMin AND status not in {resolved,closed}
 * Either clock with target=0 is considered "n/a" (returns false).
 */
export function ticketSlaStatus(
  ticket: Pick<Ticket, "priority" | "createdAt" | "firstResponseAt" | "status" | "resolvedAt"> &
    Partial<Pick<Ticket, "waitingSince" | "waitedMs">>,
  map: TicketSlaMap,
  now: Date = new Date(),
): { responseBreached: boolean; resolutionBreached: boolean } {
  const target = map[ticket.priority];
  const elapsed = ticketSlaElapsedMs(ticket, now);
  const responseBreached = target.responseMin > 0 && !ticket.firstResponseAt && elapsed > target.responseMin * 60_000;
  const resolutionBreached =
    target.resolutionMin > 0 &&
    ticket.status !== "resolved" &&
    ticket.status !== "closed" &&
    elapsed > target.resolutionMin * 60_000;
  return { responseBreached, resolutionBreached };
}

/**
 * Time on the SLA clocks: since creation, minus the time the ticket spent waiting on the requester (finished waits in
 * `waitedMs`, a wait still going on from `waitingSince`).
 */
export function ticketSlaElapsedMs(
  ticket: Pick<Ticket, "createdAt"> & Partial<Pick<Ticket, "waitingSince" | "waitedMs">>,
  now: Date,
): number {
  const total = now.getTime() - new Date(ticket.createdAt).getTime();
  const waitedNow = ticket.waitingSince ? Math.max(0, now.getTime() - new Date(ticket.waitingSince).getTime()) : 0;
  return Math.max(0, total - (ticket.waitedMs ?? 0) - waitedNow);
}

export const createTicketSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(""),
  priority: z.enum(TICKET_PRIORITIES).default("normal"),
});
export type CreateTicketInput = z.infer<typeof createTicketSchema>;

export const updateTicketSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  // null = unassign. Pass a UUID string to assign.
  assignedUserId: z.string().uuid().nullable().optional(),
});
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;

export const ticketListQuerySchema = z.object({
  status: z
    .union([z.enum(TICKET_STATUSES), z.array(z.enum(TICKET_STATUSES))])
    .optional(),
  priority: z
    .union([z.enum(TICKET_PRIORITIES), z.array(z.enum(TICKET_PRIORITIES))])
    .optional(),
  assigned: z.enum(["me", "unassigned", "any"]).optional(),
  scope: z.enum(["own", "all"]).default("own"),
  q: z.string().max(200).optional(),
  tagId: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketCommentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  body: z.string().min(1).max(20_000),
  isInternal: z.boolean(),
  kind: z.enum(["comment", "event"]).default("comment"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;

export const createCommentSchema = z.object({
  body: z.string().min(1).max(20_000),
  isInternal: z.boolean().default(false),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;

/**
 * Bulk operation envelope. Selected ticket ids + a single mutation to apply
 * to all of them. Status / priority / assignment / category match the fields
 * on the single-ticket update endpoint; the bulk endpoint then runs the
 * normal permission checks per row before applying.
 */
export const bulkTicketActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("set_status"), status: z.enum(TICKET_STATUSES) }),
    z.object({ kind: z.literal("set_priority"), priority: z.enum(TICKET_PRIORITIES) }),
    z.object({ kind: z.literal("assign"), assignedUserId: z.string().uuid().nullable() }),
    z.object({ kind: z.literal("delete") }),
  ]),
});
export type BulkTicketAction = z.infer<typeof bulkTicketActionSchema>;

// ---- canned replies ----

export const CANNED_REPLY_TITLE_MAX = 80;
export const CANNED_REPLY_BODY_MAX = 5000;

export const cannedReplySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(CANNED_REPLY_TITLE_MAX),
  body: z.string().min(1).max(CANNED_REPLY_BODY_MAX),
  createdByUserId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CannedReply = z.infer<typeof cannedReplySchema>;

export const createCannedReplySchema = z.object({
  title: z.string().trim().min(1).max(CANNED_REPLY_TITLE_MAX),
  body: z.string().trim().min(1).max(CANNED_REPLY_BODY_MAX),
});
export type CreateCannedReplyInput = z.infer<typeof createCannedReplySchema>;

export const updateCannedReplySchema = createCannedReplySchema.partial();
export type UpdateCannedReplyInput = z.infer<typeof updateCannedReplySchema>;
