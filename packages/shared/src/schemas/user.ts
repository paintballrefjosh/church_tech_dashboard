import { z } from "zod";

export const userIdSchema = z.string().uuid();

export const userSchema = z.object({
  id: userIdSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  avatarUrl: z.string().url().nullable(),
  isActive: z.boolean(),
  totpEnabled: z.boolean(),
  googleSubject: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type User = z.infer<typeof userSchema>;

export const createLocalUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  password: z.string().min(12).max(256),
});

export type CreateLocalUserInput = z.infer<typeof createLocalUserSchema>;

export const updateUserSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  isActive: z.boolean().optional(),
  avatarUrl: z.string().url().nullable().optional(),
});

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const signinCredentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().regex(/^\d{6}$/).optional(),
});

export type SigninCredentials = z.infer<typeof signinCredentialsSchema>;
