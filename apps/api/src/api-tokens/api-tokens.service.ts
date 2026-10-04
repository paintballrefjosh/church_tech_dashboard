import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, isNotNull, isNull, lte, or, type SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import {
  API_TOKEN_DEFAULT_DAYS,
  API_TOKEN_DISPLAY_CHARS,
  API_TOKEN_PREFIX,
  findModule,
  type ApiTokenAdminSummary,
  type ApiTokenCreate,
  type ApiTokenCreated,
  type ApiTokenPolicy,
  type ApiTokenStatus,
  type ApiTokenSummary,
} from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { apiTokens, users } from "../db/schema";
import { AuthService } from "../auth/auth.service";
import type { AuthenticatedUser } from "../auth/current-user.decorator";
import { SettingsService } from "../settings/settings.service";

const DAY_MS = 86_400_000;
/** Revoked/expired tokens drop out of a user's own list after this long. */
const INACTIVE_LIST_DAYS = 90;

type TokenRow = typeof apiTokens.$inferSelect;

function statusOf(row: TokenRow, now: number): ApiTokenStatus {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now) return "expired";
  return "active";
}

function toSummary(row: TokenRow, now = Date.now()): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    userId: row.userId,
    prefix: row.tokenPrefix,
    readOnly: row.readOnly,
    modules: row.modules ?? null,
    status: statusOf(row, now),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: row.lastUsedIp,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Personal API tokens: create, list, revoke. Authentication with a token
 * lives in AuthService.findUserByApiToken + SessionGuard; this is only the
 * management side. Tokens are never deleted, only revoked, so audit rows
 * that name a token keep resolving.
 */
@Injectable()
export class ApiTokensService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly settings: SettingsService,
  ) {}

  /** What the create form may offer: whether tokens are on, and the lifetime cap. */
  async policy(): Promise<ApiTokenPolicy> {
    return {
      enabled: (await this.settings.get("auth.api_tokens_enabled")) !== false,
      maxDays: await this.maxDays(),
      defaultDays: API_TOKEN_DEFAULT_DAYS,
    };
  }

  private async maxDays(): Promise<number> {
    const raw = await this.settings.get("auth.api_tokens_max_days");
    return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 365;
  }

  /** The user's own tokens, newest first; long-dead ones are left out. */
  async listForUser(userId: string): Promise<ApiTokenSummary[]> {
    const rows = await this.db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.userId, userId))
      .orderBy(desc(apiTokens.createdAt));
    const now = Date.now();
    const cutoff = now - INACTIVE_LIST_DAYS * DAY_MS;
    return rows
      .filter((r) => {
        const endedAt = r.revokedAt ?? (r.expiresAt && r.expiresAt.getTime() <= now ? r.expiresAt : null);
        return !endedAt || endedAt.getTime() >= cutoff;
      })
      .map((r) => toSummary(r, now));
  }

  /** Every token with its owner, for admins. */
  async listAll(opts: { status?: ApiTokenStatus; userId?: string }): Promise<ApiTokenAdminSummary[]> {
    const now = new Date();
    const conditions: SQL[] = [];
    if (opts.userId) conditions.push(eq(apiTokens.userId, opts.userId));
    if (opts.status === "revoked") conditions.push(isNotNull(apiTokens.revokedAt));
    if (opts.status === "expired") {
      conditions.push(isNull(apiTokens.revokedAt), lte(apiTokens.expiresAt, now));
    }
    if (opts.status === "active") {
      const notExpired = or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now));
      conditions.push(isNull(apiTokens.revokedAt));
      if (notExpired) conditions.push(notExpired);
    }
    const rows = await this.db
      .select({ token: apiTokens, userEmail: users.email, userName: users.name })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(apiTokens.createdAt));
    const t = now.getTime();
    return rows.map((r) => ({
      ...toSummary(r.token, t),
      userEmail: r.userEmail,
      userName: r.userName,
    }));
  }

  /** Create a token for `owner`, signed in themselves. */
  async createForSelf(owner: AuthenticatedUser, body: ApiTokenCreate): Promise<ApiTokenCreated> {
    return this.create(owner, body);
  }

  /** Create a token for another user, e.g. a passwordless service account. */
  async createForUser(userId: string, body: ApiTokenCreate): Promise<ApiTokenCreated> {
    const owner = await this.auth.loadUserById(userId);
    if (!owner) throw new NotFoundException("User not found, disabled or deleted");
    return this.create(owner, body);
  }

  private async create(owner: AuthenticatedUser, body: ApiTokenCreate): Promise<ApiTokenCreated> {
    if ((await this.settings.get("auth.api_tokens_enabled")) === false) {
      throw new ForbiddenException("API tokens are turned off in the auth settings");
    }
    const modules = body.modules ?? null;
    if (modules) {
      const unreachable = modules.filter((m) => !owner.access[m]);
      if (unreachable.length) {
        const labels = unreachable.map((m) => findModule(m)?.label ?? m).join(", ");
        throw new BadRequestException(`The token's owner has no access to: ${labels}`);
      }
    }
    const expiresAt = await this.resolveExpiry(body);

    const token = `${API_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const [row] = await this.db
      .insert(apiTokens)
      .values({
        name: body.name,
        tokenHash: this.auth.hashToken(token),
        tokenPrefix: token.slice(0, API_TOKEN_DISPLAY_CHARS),
        userId: owner.id,
        readOnly: body.readOnly,
        modules: modules ? [...new Set(modules)] : null,
        expiresAt,
      })
      .returning();
    if (!row) throw new Error("api token insert returned no row");
    return { ...toSummary(row), token };
  }

  /**
   * Work out the expiry from the body and the `auth.api_tokens_max_days`
   * cap (0 = no cap, and "never" allowed). null = never expires.
   */
  private async resolveExpiry(body: ApiTokenCreate): Promise<Date | null> {
    const maxDays = await this.maxDays();
    const now = Date.now();
    const tooLong = (): BadRequestException =>
      new BadRequestException(`Tokens must expire within ${maxDays} days`);

    if (body.expiresAt === null) {
      if (maxDays !== 0) throw tooLong();
      return null;
    }
    if (body.expiresAt !== undefined) {
      const at = new Date(body.expiresAt);
      if (at.getTime() <= now) throw new BadRequestException("expiresAt must be in the future");
      // A minute of slack so "exactly max days from now" picked in a form passes.
      if (maxDays > 0 && at.getTime() > now + maxDays * DAY_MS + 60_000) throw tooLong();
      return at;
    }
    const days = body.expiresInDays ?? (maxDays > 0 ? Math.min(API_TOKEN_DEFAULT_DAYS, maxDays) : API_TOKEN_DEFAULT_DAYS);
    if (maxDays > 0 && days > maxDays) throw tooLong();
    return new Date(now + days * DAY_MS);
  }

  /**
   * Revoke one token. With `ownerId`, only that user's token matches (others
   * are a 404, so ids can't be probed). Revoking twice is harmless.
   */
  async revoke(id: string, ownerId?: string): Promise<ApiTokenSummary> {
    const match = ownerId ? and(eq(apiTokens.id, id), eq(apiTokens.userId, ownerId)) : eq(apiTokens.id, id);
    const [row] = await this.db.select().from(apiTokens).where(match).limit(1);
    if (!row) throw new NotFoundException("Token not found");
    if (row.revokedAt) return toSummary(row);
    const [updated] = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(eq(apiTokens.id, id))
      .returning();
    return toSummary(updated ?? row);
  }

  /** Revoke every live token a user has. */
  async revokeAllForUser(userId: string): Promise<{ id: string; revoked: number }> {
    const [user] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundException("User not found");
    const revoked = await this.db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id });
    return { id: userId, revoked: revoked.length };
  }
}
