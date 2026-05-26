import { z } from "zod";

/**
 * Catalogue of in-app notification kinds. The string is also what we filter
 * on for per-kind preferences (Phase 1.7.1). Adding a new kind here is the
 * contract for backend code that emits one + frontend that wants to render
 * it specially.
 */
export const NOTIFICATION_KINDS = [
  "ticket.assigned",
  "ticket.status_changed",
  "ticket.comment",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notificationSchema = z.object({
  id: z.string().uuid(),
  recipientUserId: z.string().uuid(),
  kind: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  body: z.string().max(2000),
  link: z.string().max(2000).nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListQuerySchema = z.object({
  unread: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => (typeof v === "boolean" ? v : v === "true"))
    .optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;
