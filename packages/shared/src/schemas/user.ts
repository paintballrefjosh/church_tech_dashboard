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
  // Invite mode (default + recommended): no admin-set password — the new user
  // is emailed a one-time link to choose their own. When false, `password` is
  // required and the other password-mode fields below apply.
  sendInvite: z.boolean().optional().default(true),
  // Required only when sendInvite is false (enforced in the controller).
  password: z.string().min(12).max(256).optional(),
  // Force the user through /change-password on first sign-in. Default on so an
  // admin-set initial password is always replaced by one only the user knows.
  mustChangePassword: z.boolean().optional().default(true),
  // Email the new user a "get started" sign-in link (password mode only).
  // Best-effort (no-op if SMTP isn't configured); never blocks creation.
  sendWelcomeEmail: z.boolean().optional().default(true),
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
