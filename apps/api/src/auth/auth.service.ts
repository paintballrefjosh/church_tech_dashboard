import { Injectable, Inject } from "@nestjs/common";
import { eq, inArray } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { DB, type Db } from "../db/db.module";
import {
  users,
  totpSecrets,
  apiTokens,
  groups,
  groupMemberships,
  groupModuleAccess,
} from "../db/schema";
import type { AuthenticatedUser } from "./current-user.decorator";
import { scopeUserToToken } from "./api-token-scope";
import {
  MODULES,
  ALL_PERMISSIONS,
  permissionsFor,
  tierRank,
  type ModuleTier,
  API_TOKEN_PREFIX,
} from "@church/shared";

/**
 * `loadUserById` runs on every authenticated HTTP request and every Socket.IO
 * connection — three sequential queries each. Caching the resolved user +
 * permission set in-memory for a short window collapses the cost of an
 * authenticated browsing burst to a single DB roundtrip per user. Writes
 * that touch a user's perms (group membership / module access / user fields)
 * call `invalidateUser()` so admin edits take effect immediately.
 *
 * In-memory (per-process) rather than Redis: a single-replica deploy doesn't
 * need cross-process consistency, and the perf review's Redis recommendation
 * trades simplicity for future-proofing. When we go multi-replica, swap this
 * Map for a Redis-backed cache with the same shape.
 */
const USER_CACHE_TTL_MS = 30_000;
/** How stale a token's last_used_at may get before a request rewrites it. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

@Injectable()
export class AuthService {
  constructor(@Inject(DB) private readonly db: Db) {}

  private userCache = new Map<string, { at: number; user: AuthenticatedUser }>();

  async hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async verifyPassword(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  generateToken(bytes = 32): string {
    return randomBytes(bytes).toString("base64url");
  }

  /**
   * Resolve a bearer token to its owner, narrowed to the token's limits.
   * Unknown, revoked and expired tokens all return null, so the caller
   * answers each with the same 401. `last_used_at`/`last_used_ip` are
   * written at most once a minute per token, not on every call.
   */
  async findUserByApiToken(token: string, ip: string | null): Promise<AuthenticatedUser | null> {
    if (!token.startsWith(API_TOKEN_PREFIX)) return null;
    const hash = this.hashToken(token);
    const [row] = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tokenHash, hash))
      .limit(1);
    if (!row || row.revokedAt) return null;
    const now = Date.now();
    if (row.expiresAt && row.expiresAt.getTime() <= now) return null;
    const owner = await this.loadUserById(row.userId);
    if (!owner) return null;
    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS || row.lastUsedIp !== ip) {
      await this.db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(now), lastUsedIp: ip })
        .where(eq(apiTokens.id, row.id));
    }
    const limits = { readOnly: row.readOnly, modules: row.modules ?? null };
    return {
      ...scopeUserToToken(owner, limits),
      apiToken: { id: row.id, name: row.name, ...limits },
    };
  }

  async loadUserById(userId: string): Promise<AuthenticatedUser | null> {
    const now = Date.now();
    const cached = this.userCache.get(userId);
    if (cached && now - cached.at < USER_CACHE_TTL_MS) return cached.user;

    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user || !user.isActive || user.deletedAt) {
      this.userCache.delete(userId);
      return null;
    }

    // Resolve permissions via the (module, tier) model. group_module_access
    // is the source of truth — the legacy group_permissions, role tables,
    // etc. linger as safety nets but are never read.
    const memberships = await this.db
      .select({ groupId: groupMemberships.groupId, groupName: groups.name })
      .from(groupMemberships)
      .innerJoin(groups, eq(groups.id, groupMemberships.groupId))
      .where(eq(groupMemberships.userId, userId));
    const groupIds = memberships.map((g) => g.groupId);
    const groupNames = memberships.map((g) => g.groupName);

    // Short-circuit: the admin group always grants admin tier on every
    // module (and every permission string in the catalog), regardless of
    // what rows happen to exist in group_module_access. Belt and braces
    // alongside the UI/API lock that prevents editing the admin group.
    const isAdmin = groupNames.includes("admin");
    const access: Record<string, ModuleTier> = {};
    let permissions: string[];

    if (isAdmin) {
      for (const m of MODULES) {
        access[m.key] = m.tiers[m.tiers.length - 1] as ModuleTier;
      }
      permissions = [...ALL_PERMISSIONS];
    } else if (groupIds.length === 0) {
      permissions = [];
    } else {
      const rows = await this.db
        .select({ moduleKey: groupModuleAccess.moduleKey, tier: groupModuleAccess.tier })
        .from(groupModuleAccess)
        .where(inArray(groupModuleAccess.groupId, groupIds));
      // Highest tier per module wins when a user is in multiple groups.
      for (const r of rows) {
        const t = r.tier as ModuleTier;
        const current = access[r.moduleKey];
        if (!current || tierRank(r.moduleKey, t) > tierRank(r.moduleKey, current)) {
          access[r.moduleKey] = t;
        }
      }
      const set = new Set<string>();
      for (const [moduleKey, tier] of Object.entries(access)) {
        for (const p of permissionsFor(moduleKey, tier)) set.add(p);
      }
      permissions = [...set];
    }

    const resolved: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      isActive: user.isActive,
      totpEnabled: user.totpEnabled,
      mustChangePassword: user.mustChangePassword,
      approvalStatus: user.approvalStatus === "pending" ? "pending" : "approved",
      groups: groupNames,
      permissions,
      access,
    };
    this.userCache.set(userId, { at: now, user: resolved });
    return resolved;
  }

  /**
   * Drop the cached user record so the next loadUserById hits the DB.
   * Call this from any write path that affects what `loadUserById` returns:
   * user profile edits, group membership changes, module-access changes,
   * activation/deactivation, password resets.
   */
  invalidateUser(userId: string): void {
    this.userCache.delete(userId);
  }

  /** Drop every cached user. Use sparingly — e.g. when bulk perm changes
   *  cross every user (admin-group reseed). */
  invalidateAllUsers(): void {
    this.userCache.clear();
  }

  async getTotpSecret(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .limit(1);
    return row?.secret ?? null;
  }
}
