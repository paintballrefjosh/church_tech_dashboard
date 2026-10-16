import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { describeUserAgent, type UserAgentInfo } from "@church/shared";
import { DB, type Db } from "../db/db.module";
import { userSessions } from "../db/schema";
import { ClusterJobs } from "../cluster/cluster-jobs.service";
import { deleteInBatches } from "../retention/batched-delete";
import { AuthService } from "./auth.service";

/** A session counts as live while its cookie could still be valid (the web's cookie lasts 14 days unused). */
export const SESSION_LIVE_DAYS = 14;
/** How long a row that nobody has used is kept, and how long an ended session is remembered (so a late cookie stays refused). */
const IDLE_KEEP_DAYS = 30;
const REVOKED_KEEP_DAYS = 90;
/** `last_seen_at`, address and browser are written at most this often per session and node. */
const TOUCH_EVERY_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export interface SessionRow {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  browser: UserAgentInfo;
  current: boolean;
}

/**
 * The list behind "your sessions". A session row is made by the API the first time it sees a cookie's `sid`
 * (`touch`), so the web needs no database write at sign-in. Ending one sets `revoked_at` and drops the cached user on
 * every node (`AuthService.invalidateUser`), after which `SessionGuard` and the realtime gateway refuse that cookie.
 */
@Injectable()
export class SessionsService implements OnModuleInit {
  private readonly logger = new Logger(SessionsService.name);
  private readonly touched = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly auth: AuthService,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({ name: "sessions-prune", everyMs: 6 * 60 * 60_000, initialDelayMs: 10 * 60_000, run: async () => void (await this.prune()) });
  }

  /**
   * Note that a session was used just now. Cheap by design: a per-node timer means one write per session per few
   * minutes, never one per request, and a failure here never fails the request. A row that exists for another account
   * (an impossible id, since the id comes from a signed cookie) is left alone.
   */
  touch(userId: string, sid: string, ip: string | null, userAgent: string | null, now: number = Date.now()): void {
    const last = this.touched.get(sid);
    if (last !== undefined && now - last < TOUCH_EVERY_MS) return;
    this.touched.set(sid, now);
    if (this.touched.size > 5000) {
      for (const [k, at] of this.touched) if (now - at > TOUCH_EVERY_MS) this.touched.delete(k);
    }
    const at = new Date(now);
    void this.db
      .insert(userSessions)
      .values({ id: sid, userId, ip, userAgent: userAgent?.slice(0, 300) ?? null, createdAt: at, lastSeenAt: at })
      .onConflictDoUpdate({
        target: userSessions.id,
        set: { lastSeenAt: at, ip, userAgent: userAgent?.slice(0, 300) ?? null },
        setWhere: and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)),
      })
      .catch((err: Error) => {
        this.touched.delete(sid);
        this.logger.debug(`session touch failed: ${err.message}`);
      });
  }

  async list(userId: string, currentSid: string | null, now: Date = new Date()): Promise<SessionRow[]> {
    const since = new Date(now.getTime() - SESSION_LIVE_DAYS * DAY_MS);
    const rows = await this.db
      .select()
      .from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt), gt(userSessions.lastSeenAt, since)))
      .orderBy(desc(userSessions.lastSeenAt));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      ip: r.ip,
      browser: describeUserAgent(r.userAgent),
      current: currentSid !== null && r.id.toLowerCase() === currentSid,
    }));
  }

  /** End one session of this account. Returns false when there is no such live session (nothing to do). */
  async revoke(userId: string, sessionId: string): Promise<boolean> {
    const done = await this.db
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, sessionId), eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });
    if (done.length === 0) return false;
    this.auth.invalidateUser(userId);
    return true;
  }

  /**
   * End the session the request came in on. The id is proven by the signed cookie, so the row is created if its first
   * `touch` has not landed yet: signing out right after signing in must still end the session.
   */
  async revokeCurrent(userId: string, sid: string): Promise<void> {
    const at = new Date();
    await this.db
      .insert(userSessions)
      .values({ id: sid, userId, createdAt: at, lastSeenAt: at, revokedAt: at })
      .onConflictDoUpdate({
        target: userSessions.id,
        set: { revokedAt: at },
        setWhere: and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)),
      });
    this.auth.invalidateUser(userId);
  }

  /** End every listed session except the one asked from. Cookies with no id (older ones) are not touched. */
  async revokeOthers(userId: string, keepSid: string | null): Promise<number> {
    const where = and(
      eq(userSessions.userId, userId),
      isNull(userSessions.revokedAt),
      keepSid ? ne(userSessions.id, keepSid) : undefined,
    );
    const done = await this.db.update(userSessions).set({ revokedAt: new Date() }).where(where).returning({ id: userSessions.id });
    if (done.length > 0) this.auth.invalidateUser(userId);
    return done.length;
  }

  /** Forget the rows nothing can use any more. An ended session is kept longer so a stray cookie never revives it. */
  async prune(now: Date = new Date()): Promise<number> {
    const idleCut = new Date(now.getTime() - IDLE_KEEP_DAYS * DAY_MS);
    const revokedCut = new Date(now.getTime() - REVOKED_KEEP_DAYS * DAY_MS);
    try {
      const gone = await deleteInBatches(async (limit) => {
        const removed = await this.db
          .delete(userSessions)
          .where(
            inArray(
              userSessions.id,
              this.db
                .select({ id: userSessions.id })
                .from(userSessions)
                .where(or(and(isNull(userSessions.revokedAt), lt(userSessions.lastSeenAt, idleCut)), and(isNotNull(userSessions.revokedAt), lt(userSessions.revokedAt, revokedCut))))
                .limit(limit),
            ),
          )
          .returning({ id: userSessions.id });
        return removed.length;
      });
      if (gone > 0) this.logger.log(`sessions: removed ${gone} old session rows`);
      return gone;
    } catch (err) {
      this.logger.warn(`session prune failed: ${(err as Error).message}`);
      return 0;
    }
  }
}

