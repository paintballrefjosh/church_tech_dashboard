import { permissionsFor } from "@church/shared";
import type { AuthenticatedUser } from "./current-user.decorator";

/** The limits a token puts on its owner. */
export interface ApiTokenLimits {
  readOnly: boolean;
  /** null = every module the owner can reach. */
  modules: string[] | null;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** True for methods a read-only token may use. */
export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has((method || "GET").toUpperCase());
}

/**
 * Narrow an owner's resolved access to what a token allows: the owner's
 * permissions intersected with everything the token's modules could grant
 * (each module at its top tier), and the per-module tiers cut to those
 * modules. Never adds anything the owner lacks. Returns a new object: the
 * owner record comes from AuthService's shared cache and must not be mutated.
 */
export function scopeUserToToken(user: AuthenticatedUser, limits: ApiTokenLimits): AuthenticatedUser {
  if (limits.modules === null) return { ...user };
  const allowed = new Set<string>();
  for (const m of limits.modules) {
    for (const p of permissionsFor(m, "admin")) allowed.add(p);
  }
  const access: AuthenticatedUser["access"] = {};
  for (const m of limits.modules) {
    const tier = user.access[m];
    if (tier) access[m] = tier;
  }
  return {
    ...user,
    permissions: user.permissions.filter((p) => allowed.has(p)),
    access,
  };
}
