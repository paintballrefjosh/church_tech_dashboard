import { z } from "zod";
import { TAG_COLORS } from "./tag";

/**
 * Categories reuse the tag colour palette so the picker chips render with the
 * same Tailwind utilities — no design coupling beyond the colour names.
 */
export const TICKET_CATEGORY_COLORS = TAG_COLORS;
export type TicketCategoryColor = (typeof TICKET_CATEGORY_COLORS)[number];

export const ticketCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(64),
  color: z.enum(TICKET_CATEGORY_COLORS),
  createdAt: z.string().datetime(),
});
export type TicketCategory = z.infer<typeof ticketCategorySchema>;

export const createTicketCategorySchema = z.object({
  name: z.string().trim().min(1).max(64),
  color: z.enum(TICKET_CATEGORY_COLORS).default("slate"),
});
export type CreateTicketCategoryInput = z.infer<typeof createTicketCategorySchema>;

export const updateTicketCategorySchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  color: z.enum(TICKET_CATEGORY_COLORS).optional(),
});
export type UpdateTicketCategoryInput = z.infer<typeof updateTicketCategorySchema>;

/** Full-replace semantics: client sends the intended end-state. */
export const setTicketCategoriesSchema = z.object({
  categoryIds: z.array(z.string().uuid()).max(20),
});
export type SetTicketCategoriesInput = z.infer<typeof setTicketCategoriesSchema>;
