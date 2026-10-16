import { Injectable, Inject, type OnModuleInit } from "@nestjs/common";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { authenticator } from "otplib";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { DB, type Db } from "../db/db.module";
import { CACHE_ROOM, ClusterBus } from "../cluster/cluster-bus.service";
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
import { decryptStoredSecret, encryptSecret, isEncrypted } from "../settings/crypto";
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
 * In-memory (per-process). With several nodes, an invalidation is also sent over
 * the cluster bus so the other nodes drop their copy within about a second
 * rather than when the 30s TTL runs out; that matters for revoking access.
 */
const USER_CACHE_TTL_MS = 30_000;
/** How stale a token's last_used_at may get before a request rewrites it. */
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly bus: ClusterBus,
  ) {}

  onModuleInit(): void {
    // Another node changed a user (or many): forget our copy. Local only, so it never echoes.
    this.bus.onEvent((row) => {
      if (row.room !== CACHE_ROOM) return;
      if (row.event === "user") {
        const id = (row.payload as { id?: string } | null)?.id;
        if (id) this.userCache.delete(id);
      } else if (row.event === "users") {
        this.userCache.clear();
      }
    });
  }

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
    const limits = { readOnly: row.readOnly, allowOperational: row.allowOperational, modules: row.modules ?? null };
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
      sessionVersion: user.sessionVersion,
      approvalStatus: user.approvalStatus === "pending" ? "pending" : "approved",
      groups: groupNames,
      groupIds,
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
    this.bus.publish({ room: CACHE_ROOM, event: "user", payload: { id: userId } });
  }

  /**
   * Sign the account out of every browser: bump its session version, so each cookie issued so far stops
   * matching. Used when the credentials change (password change or reset, two-factor removed or reset).
   * The caller's own cookie dies too; the web sign-out flow sends the person to the sign-in page.
   */
  async revokeSessions(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, userId));
    this.invalidateUser(userId);
  }

  /** Drop every cached user. Use sparingly — e.g. when bulk perm changes
   *  cross every user (admin-group reseed). */
  invalidateAllUsers(): void {
    this.userCache.clear();
    this.bus.publish({ room: CACHE_ROOM, event: "users" });
  }

  /**
   * The user's TOTP secret in the clear. Stored encrypted like every other secret (`enc:v1:` prefix); a row
   * written before that was plaintext and is encrypted in place on first read. A secret saved under another
   * AUTH_SECRET throws `UnreadableSecretError`: the account's two-factor then has to be reset by an admin.
   */
  async getTotpSecret(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select()
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .limit(1);
    if (!row) return null;
    if (!isEncrypted(row.secret)) {
      await this.db
        .update(totpSecrets)
        .set({ secret: encryptSecret(row.secret) })
        .where(and(eq(totpSecrets.userId, userId), eq(totpSecrets.secret, row.secret)))
        .catch(() => undefined);
      return row.secret;
    }
    return decryptStoredSecret(row.secret, "two-factor secret");
  }

  /**
   * Check a 6-digit code and burn it: a code is accepted once, and never for a step at or before the last one
   * accepted, so a code someone watched being typed cannot be replayed within its validity window. The step is
   * claimed with a conditional update, so two simultaneous requests with the same code cannot both pass.
   */
  async verifyTotpCode(userId: string, code: string): Promise<boolean> {
    const secret = await this.getTotpSecret(userId);
    if (!secret) return false;
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return false;
    const step = Math.floor(Date.now() / (authenticator.allOptions().step * 1000)) + delta;
    const claimed = await this.db
      .update(totpSecrets)
      .set({ lastStep: step })
      .where(and(eq(totpSecrets.userId, userId), or(isNull(totpSecrets.lastStep), lt(totpSecrets.lastStep, step))))
      .returning({ userId: totpSecrets.userId });
    return claimed.length === 1;
  }

  /**
   * Spend a recovery code. The code is removed from the stored list in the same statement that finds it, so
   * of two simultaneous uses of one code exactly one succeeds.
   */
  async consumeRecoveryCode(userId: string, plaintext: string): Promise<boolean> {
    const hash = hashRecoveryCode(plaintext);
    const spent = await this.db
      .update(totpSecrets)
      .set({ recoveryCodes: sql`array_remove(${totpSecrets.recoveryCodes}, ${hash}::text)` })
      .where(and(eq(totpSecrets.userId, userId), sql`${hash}::text = ANY(${totpSecrets.recoveryCodes})`))
      .returning({ userId: totpSecrets.userId });
    return spent.length === 1;
  }

  private dummyHash: Promise<string> | null = null;

  /**
   * Verify a password against a stored hash, or burn the same time against a throwaway hash when there is no
   * account to check, so "no such account" and "wrong password" take equally long.
   */
  async verifyPasswordOrDecoy(hash: string | null | undefined, password: string): Promise<boolean> {
    if (hash) return this.verifyPassword(hash, password);
    this.dummyHash ??= this.hashPassword(randomBytes(16).toString("hex"));
    await this.verifyPassword(await this.dummyHash, password);
    return false;
  }
}

/** Recovery codes are compared by the SHA-256 of the code without dashes, upper-cased. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/-/g, "")).digest("hex");
}
