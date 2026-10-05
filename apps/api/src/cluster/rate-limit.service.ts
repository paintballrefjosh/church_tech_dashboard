import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { Pool } from "pg";
import { DB_POOL } from "../db/db.module";
import { ClusterJobs } from "./cluster-jobs.service";

/** What @fastify/rate-limit's `incr` hands back. */
interface Hit {
  current: number;
  ttl: number;
  ban: boolean;
}
type IncrCallback = (err: Error | null, hit?: Hit) => void;

interface StoreParams {
  timeWindow: number;
  continueExceeding?: boolean;
  /** Set on a route's `config.rateLimit` to count that route in the database. */
  shared?: boolean;
  routeInfo?: { method?: string | string[]; url?: string };
}

/** Fixed-window counters in memory, per process. The general limit uses this. */
class MemoryBuckets {
  private readonly buckets = new Map<string, { current: number; start: number }>();
  constructor(
    private readonly timeWindow: number,
    private readonly continueExceeding: boolean,
  ) {}

  incr(key: string, cb: IncrCallback, max: number): void {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.start + this.timeWindow <= now) {
      b = { current: 1, start: now };
    } else {
      b.current++;
      if (this.continueExceeding && b.current > max) b.start = now;
    }
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) {
      for (const [k, v] of this.buckets) if (v.start + this.timeWindow <= now) this.buckets.delete(k);
    }
    cb(null, { current: b.current, ttl: this.timeWindow - (now - b.start), ban: false });
  }
}

/**
 * Fixed-window counters in `rate_limit_buckets`, shared by every node. One
 * statement per request: the window rolls over inside the UPSERT, judged by the
 * database clock.
 */
class DbBuckets {
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly namespace: string,
    private readonly timeWindow: number,
  ) {}

  incr(key: string, cb: IncrCallback): void {
    void this.incrWithRetry(key).then(
      (hit) => cb(null, hit),
      (err: Error) => cb(err),
    );
  }

  /**
   * Concurrent hits on one key conflict in the database (serialization failure,
   * SQLSTATE 40001, which YugabyteDB's default isolation raises instead of waiting).
   * A few retries make every request count; giving up would let a burst of
   * parallel requests slip past the limit uncounted.
   */
  private async incrWithRetry(key: string): Promise<Hit> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.incrOnce(key);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "40001" || attempt >= 8) throw err;
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * attempt));
      }
    }
  }

  private async incrOnce(key: string): Promise<Hit> {
    const window = `($2::text || ' milliseconds')::interval`;
    const res = await this.pool
      .query<{ count: number | string; ttl_ms: number | string }>(
        `INSERT INTO rate_limit_buckets (key, count, window_start) VALUES ($1, 1, now())
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limit_buckets.window_start + ${window} <= now()
                        THEN 1 ELSE rate_limit_buckets.count + 1 END,
           window_start = CASE WHEN rate_limit_buckets.window_start + ${window} <= now()
                               THEN now() ELSE rate_limit_buckets.window_start END
         RETURNING count,
           (extract(epoch FROM (window_start + ${window} - now())) * 1000)::int AS ttl_ms`,
        [`${this.namespace}|${key}`, String(this.timeWindow)],
      );
    const row = res.rows[0]!;
    return { current: Number(row.count), ttl: Math.max(0, Number(row.ttl_ms)), ban: false };
  }
}

/**
 * @fastify/rate-limit store: per-process memory for the general per-IP limit,
 * the database for routes that set `config.rateLimit.shared` (sign-in, TOTP,
 * password change), so brute-force protection does not weaken as nodes are
 * added. The plugin builds one `child` per route from the merged route options.
 */
@Injectable()
export class RateLimitService implements OnModuleInit {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly jobs: ClusterJobs,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: "rate-limit-prune",
      everyMs: 10 * 60_000,
      initialDelayMs: 2 * 60_000,
      run: async () => {
        await this.pool.query(`DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 hour'`);
      },
    });
  }

  /** The class to pass as the plugin's `store` option. */
  storeClass(): new (params: StoreParams) => unknown {
    const pool = this.pool;
    return class RateLimitStore {
      private readonly memory: MemoryBuckets;
      constructor(private readonly params: StoreParams) {
        this.memory = new MemoryBuckets(params.timeWindow, !!params.continueExceeding);
      }

      incr(key: string, cb: IncrCallback, max: number): void {
        this.memory.incr(key, cb, max);
      }

      child(route: StoreParams): unknown {
        if (route.shared) {
          const method = Array.isArray(route.routeInfo?.method) ? route.routeInfo.method.join(",") : route.routeInfo?.method;
          return new DbBuckets(pool, `${method ?? "*"}:${route.routeInfo?.url ?? "*"}`, route.timeWindow);
        }
        return new MemoryBuckets(route.timeWindow, !!route.continueExceeding);
      }
    };
  }
}
