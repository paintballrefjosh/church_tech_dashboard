import { z } from "zod";

export const groupIdSchema = z.string().uuid();

export const groupSchema = z.object({
  id: groupIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable(),
  googleGroupId: z.string().nullable(),
  googleGroupEmail: z.string().email().nullable(),
  isManaged: z.boolean(), // true = synced from Google, do not allow local edits
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Group = z.infer<typeof groupSchema>;

export const createGroupSchema = z.object({
  name: z.string().min(1).max(120),
  // Allow null so the admin UI can clear the description by sending `null`;
  // omit the field entirely (undefined) to leave it untouched on PATCH.
  description: z.string().max(1000).nullable().optional(),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = createGroupSchema.partial();
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;
