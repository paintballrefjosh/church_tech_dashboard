import { z } from "zod";
import {
  PERMISSIONS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  createCannedReplySchema,
  createCommentSchema,
  createTicketCategorySchema,
  createTicketSchema,
  setTicketCategoriesSchema,
  ticketListQuerySchema,
  updateCannedReplySchema,
  updateTicketCategorySchema,
  updateTicketSchema,
} from "@church/shared";
import { defineTool } from "../bridge.types";

const id = z.string().uuid();
const ticketLink = (r: unknown) => {
  const ticket = r as { id?: string };
  return ticket?.id ? `/tickets/${ticket.id}` : null;
};

/** Helpdesk: tickets, their comments, and the category catalogue. */
export const TICKET_TOOLS = [
  defineTool({
    name: "tickets_list",
    title: "List tickets",
    description:
      "List tickets you can see, newest first. Filter by status, priority, who it is assigned to, or words; scope 'all' needs staff access, the default 'own' is your own tickets. Returns number, title, status, priority, assignee and timestamps; use tickets_get for the description.",
    cls: "read",
    method: "GET",
    path: "/tickets",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object(ticketListQuerySchema.shape),
  }),
  defineTool({
    name: "tickets_get",
    title: "Read a ticket",
    description: "One ticket with its full description. Comments are separate: tickets_list_comments.",
    cls: "read",
    method: "GET",
    path: "/tickets/:id",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({ id }),
    link: ticketLink,
  }),
  defineTool({
    name: "tickets_create",
    title: "Create a ticket",
    description:
      "Open a helpdesk ticket as the token's owner. Write a specific title and put the details (what, where, since when) in the description. Staff are notified through the normal assignment rules.",
    cls: "write",
    method: "POST",
    path: "/tickets",
    permissions: [PERMISSIONS.TICKETS_WRITE_OWN],
    input: z.object(createTicketSchema.shape),
    link: ticketLink,
  }),
  defineTool({
    name: "tickets_update",
    title: "Update a ticket",
    description:
      "Change a ticket's title, description, status, priority or assignee. Only the fields you give change. Status 'waiting' means waiting on the requester: the SLA clocks pause, and their reply puts the ticket back to work. To take a ticket, set assignedUserId to your own user id (me_get_profile); null unassigns. People who follow the ticket are notified of assignment and status changes, as for any edit.",
    cls: "write",
    method: "PATCH",
    path: "/tickets/:id",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({ id, ...updateTicketSchema.shape }),
    link: ticketLink,
  }),
  defineTool({
    name: "tickets_bulk_update",
    title: "Update many tickets",
    description:
      "Set the status or priority of, or assign, up to 200 tickets at once. Each ticket is permission-checked on its own; the answer counts applied, skipped (not allowed or not found) and failed.",
    cls: "write",
    method: "POST",
    path: "/tickets/bulk",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({
      ids: z.array(id).min(1).max(200),
      // The route also accepts a delete action; agents are not offered it.
      action: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("set_status"), status: z.enum(TICKET_STATUSES) }),
        z.object({ kind: z.literal("set_priority"), priority: z.enum(TICKET_PRIORITIES) }),
        z.object({ kind: z.literal("assign"), assignedUserId: id.nullable() }),
      ]),
    }),
  }),
  defineTool({
    name: "tickets_list_comments",
    title: "Read ticket comments",
    description: "A ticket's comments and event entries, oldest first. Internal comments appear only if you may see them.",
    cls: "read",
    method: "GET",
    path: "/tickets/:id/comments",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({ id }),
  }),
  defineTool({
    name: "tickets_add_comment",
    title: "Comment on a ticket",
    description:
      "Add a comment. The ticket's creator and assignee are notified, and @mentions in the text notify the people named. isInternal comments are for staff only and hidden from the requester.",
    cls: "write",
    method: "POST",
    path: "/tickets/:id/comments",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({ id, ...createCommentSchema.shape }),
  }),
  defineTool({
    name: "ticket_categories_list",
    title: "List ticket categories",
    description: "The ticket category catalogue (id, name, colour).",
    cls: "read",
    method: "GET",
    path: "/ticket-categories",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({}),
  }),
  defineTool({
    name: "ticket_categories_get_for_ticket",
    title: "Categories of a ticket",
    description: "The categories currently set on one ticket (id, name, colour).",
    cls: "read",
    method: "GET",
    path: "/ticket-categories/for/:ticketId",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    input: z.object({ ticketId: id }),
  }),
  defineTool({
    name: "ticket_categories_set_for_ticket",
    title: "Set a ticket's categories",
    description:
      "Replace the categories on a ticket with exactly the ones given (an empty list clears them). Read the current set first if you only want to add one.",
    cls: "write",
    method: "PUT",
    path: "/ticket-categories/for/:ticketId",
    permissions: [PERMISSIONS.TICKETS_READ_OWN],
    idempotent: true,
    input: z.object({ ticketId: id, ...setTicketCategoriesSchema.shape }),
  }),
  defineTool({
    name: "ticket_categories_create",
    title: "Create a ticket category",
    description: "Add a category to the catalogue. Needs the ticket category admin permission.",
    cls: "write",
    method: "POST",
    path: "/ticket-categories",
    permissions: [PERMISSIONS.TICKETS_CATEGORIES_ADMIN],
    input: z.object(createTicketCategorySchema.shape),
  }),
  defineTool({
    name: "ticket_categories_update",
    title: "Edit a ticket category",
    description: "Rename a category or change its colour. Needs the ticket category admin permission.",
    cls: "write",
    method: "PATCH",
    path: "/ticket-categories/:id",
    permissions: [PERMISSIONS.TICKETS_CATEGORIES_ADMIN],
    idempotent: true,
    input: z.object({ id, ...updateTicketCategorySchema.shape }),
  }),
  defineTool({
    name: "tickets_list_canned_replies",
    title: "List canned replies",
    description:
      "The saved answers staff paste into ticket comments. {{requester}}, {{agent}}, {{ticket_number}} and {{ticket_title}} in a body are filled in by the web page; fill them yourself when you use one.",
    cls: "read",
    method: "GET",
    path: "/tickets/canned-replies",
    permissions: [PERMISSIONS.TICKETS_READ_ANY],
    input: z.object({}),
  }),
  defineTool({
    name: "tickets_create_canned_reply",
    title: "Create a canned reply",
    description: "Save a reusable answer (title and body). Needs ticket admin access.",
    cls: "write",
    method: "POST",
    path: "/tickets/canned-replies",
    permissions: [PERMISSIONS.TICKETS_ADMIN],
    input: z.object(createCannedReplySchema.shape),
  }),
  defineTool({
    name: "tickets_update_canned_reply",
    title: "Edit a canned reply",
    description: "Change a saved answer's title or body. Needs ticket admin access.",
    cls: "write",
    method: "PATCH",
    path: "/tickets/canned-replies/:id",
    permissions: [PERMISSIONS.TICKETS_ADMIN],
    idempotent: true,
    input: z.object({ id, ...updateCannedReplySchema.shape }),
  }),
];
