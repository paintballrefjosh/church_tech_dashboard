import { z } from "zod";

export const auditEntrySchema = z.object({
  id: z.string().uuid(),
  actorUserId: z.string().uuid().nullable(),
  actorEmail: z.string().email().nullable(),
  action: z.string().min(1).max(64), // e.g. "user.create", "role.update"
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  ts: z.string().datetime(),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
  cursor: z.string().datetime().optional(),
  actorUserId: z.string().uuid().optional(),
  resourceType: z.string().optional(),
  action: z.string().optional(),
  // Inclusive lower-bound / exclusive upper-bound on `ts`. `from`/`to` are
  // accepted as either full datetime strings or YYYY-MM-DD (we treat YYYY-MM-DD
  // as midnight UTC for the UI date-picker case).
  from: z.string().min(8).max(40).optional(),
  to: z.string().min(8).max(40).optional(),
});

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;
