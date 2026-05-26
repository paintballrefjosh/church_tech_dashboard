import { z } from "zod";

export const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
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
  resolvedAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
});
export type Ticket = z.infer<typeof ticketSchema>;

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
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;

export const ticketCommentSchema = z.object({
  id: z.string().uuid(),
  ticketId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  body: z.string().min(1).max(20_000),
  isInternal: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;

export const createCommentSchema = z.object({
  body: z.string().min(1).max(20_000),
  isInternal: z.boolean().default(false),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
