import { z } from "zod";
import { ALL_MODULE_KEYS } from "../modules";

/**
 * Personal API tokens (bearer auth for scripts and agents). A token acts as
 * its owner, narrowed by two optional limits: read-only (no POST/PUT/PATCH/
 * DELETE) and a module list. See apps/api/src/api-tokens/.
 */

/** Every token starts with this, so people and secret scanners can spot one. */
export const API_TOKEN_PREFIX = "cdt_";
/** Characters of the token kept in the clear for display (`cdt_x7Kq`). */
export const API_TOKEN_DISPLAY_CHARS = 8;
/** Expiry used when a create request names none. */
export const API_TOKEN_DEFAULT_DAYS = 90;

export const API_TOKEN_STATUSES = ["active", "expired", "revoked"] as const;
export type ApiTokenStatus = (typeof API_TOKEN_STATUSES)[number];

const moduleKey = z.string().refine((k) => ALL_MODULE_KEYS.includes(k), {
  message: "Unknown module",
});

/**
 * Create body. Expiry is one of:
 *   - `expiresInDays` (1-3650), or
 *   - `expiresAt` (an ISO datetime in the future), or
 *   - `expiresAt: null` for a token that never expires (only when the
 *     `auth.api_tokens_max_days` setting is 0), or
 *   - neither, for API_TOKEN_DEFAULT_DAYS (capped by the setting).
 * `readOnly` defaults to true. `modules: null` (or omitted) means every module
 * the owner can reach.
 */
export const apiTokenCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    readOnly: z.boolean().default(true),
    modules: z.array(moduleKey).min(1).max(ALL_MODULE_KEYS.length).nullable().optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict()
  .refine((b) => !(b.expiresInDays !== undefined && b.expiresAt !== undefined), {
    message: "Send expiresInDays or expiresAt, not both",
  });

export type ApiTokenCreate = z.infer<typeof apiTokenCreateSchema>;

export const apiTokenListQuerySchema = z.object({
  status: z.enum(API_TOKEN_STATUSES).optional(),
  userId: z.string().uuid().optional(),
});

/** A token as listed. Never carries the secret or its hash. */
export interface ApiTokenSummary {
  id: string;
  name: string;
  /** The owner: the user the token acts as. */
  userId: string;
  /** First API_TOKEN_DISPLAY_CHARS characters, e.g. "cdt_x7Kq". */
  prefix: string | null;
  readOnly: boolean;
  /** null = every module the owner can reach. */
  modules: string[] | null;
  status: ApiTokenStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** Admin listing: the token plus its owner. */
export interface ApiTokenAdminSummary extends ApiTokenSummary {
  userEmail: string;
  userName: string | null;
}

/** Create response: the summary plus the plaintext token, shown exactly once. */
export interface ApiTokenCreated extends ApiTokenSummary {
  token: string;
}

/** GET /me/api-tokens/policy: what a create form may offer. */
export interface ApiTokenPolicy {
  /** auth.api_tokens_enabled */
  enabled: boolean;
  /** auth.api_tokens_max_days; 0 = no cap, and "never expires" is allowed. */
  maxDays: number;
  /** Expiry used when a create request names none (capped by maxDays). */
  defaultDays: number;
}
