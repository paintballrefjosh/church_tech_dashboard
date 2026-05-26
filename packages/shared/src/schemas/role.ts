import { z } from "zod";

export const roleIdSchema = z.string().uuid();

export const roleSchema = z.object({
  id: roleIdSchema,
  key: z.string().min(1).max(64),
  description: z.string().max(500).nullable(),
  isSystem: z.boolean(), // system roles (admin/support_engineer/user) cannot be deleted
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Role = z.infer<typeof roleSchema>;

export const createRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "lowercase, digits, underscore; must start with a letter"),
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).default([]),
});

export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  description: z.string().max(500).optional(),
  permissions: z.array(z.string()).optional(),
});

export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
