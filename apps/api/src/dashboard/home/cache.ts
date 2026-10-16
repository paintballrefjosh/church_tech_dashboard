/**
 * A tiny per-node TTL cache with single-flight, for reads that every open home page would otherwise repeat
 * (other systems' APIs, and queries that give the same answer to everyone).
 *
 * - A value younger than the TTL is returned as is.
 * - Otherwise one load runs per key, however many callers ask meanwhile.
 * - If that load fails, the last good value is served until it is older than `STALE_FACTOR` times
 *   the TTL; after that the error is thrown.
 * - Opt-in `failTtlMs`: a failure (or a missed `deadlineMs`) is remembered for that long, and callers in
 *   the window get it at once instead of each waiting out the same dead or slow dependency and hitting it
 *   again. Without it every call after a failure tries again.
 * - Opt-in `deadlineMs`: a caller stops waiting after that long. The load itself carries on and fills the
 *   cache if it eventually succeeds.
 *
 * It is lazy (no timers) and holds only reads, so it never needs invalidating across nodes. At most
 * `maxEntries` keys are kept (expired ones go first), so a key per user cannot grow without bound.
 */
export const STALE_FACTOR = 5;

interface Entry<T> {
  value: T;
  at: number;
  ttlMs: number;
}

interface Failure {
  error: unknown;
  at: number;
}

export interface CacheGetOptions {
  /** Remember a failure this long and rethrow it at once (default 0: try again on the next call). */
  failTtlMs?: number;
  /** Stop waiting for the load after this long, as a failure ("timed out"). */
  deadlineMs?: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly failures = new Map<string, Failure>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly maxEntries = 500,
  ) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: CacheGetOptions = {}): Promise<T> {
    const hit = this.entries.get(key) as Entry<T> | undefined;
    if (hit && this.clock() - hit.at < ttlMs) return hit.value;

    const failTtl = opts.failTtlMs ?? 0;
    const stale = (): T | undefined => {
      const last = this.entries.get(key) as Entry<T> | undefined;
      return last && this.clock() - last.at <= ttlMs * STALE_FACTOR ? last.value : undefined;
    };
    const recent = this.failures.get(key);
    if (failTtl > 0 && recent && this.clock() - recent.at < failTtl) {
      const fallback = stale();
      if (fallback !== undefined) return fallback;
      throw recent.error;
    }

    let flight = this.inflight.get(key) as Promise<T> | undefined;
    if (!flight) {
      flight = load().then(
        (value) => {
          this.entries.set(key, { value, at: this.clock(), ttlMs });
          this.failures.delete(key);
          this.inflight.delete(key);
          this.sweep();
          return value;
        },
        (err: unknown) => {
          this.inflight.delete(key);
          this.failures.set(key, { error: err, at: this.clock() });
          throw err;
        },
      );
      this.inflight.set(key, flight);
    }
    try {
      return opts.deadlineMs ? await this.within(flight, opts.deadlineMs, key) : await flight;
    } catch (err) {
      const fallback = stale();
      if (fallback !== undefined) return fallback;
      throw err;
    }
  }

  /** Waits for `flight` at most `ms`; a miss is recorded as a failure so the next callers need not wait. */
  private within<T>(flight: Promise<T>, ms: number, key: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error("timed out");
        this.failures.set(key, { error, at: this.clock() });
        reject(error);
      }, ms);
    });
    // The load may fail after we stopped listening: keep that from becoming an unhandled rejection.
    flight.catch(() => undefined);
    return Promise.race([flight, limit]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  /** Drop what has aged out; if still over the limit, the oldest. */
  private sweep(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = this.clock();
    for (const [k, e] of this.entries) if (now - e.at > e.ttlMs * STALE_FACTOR) this.entries.delete(k);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Forget one key, or everything. */
  clear(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      this.failures.clear();
    } else {
      this.entries.delete(key);
      this.failures.delete(key);
    }
  }
}

/** Rejects with `Error(label)` if `work` takes longer than `ms`. The work itself is not cancelled. */
export function withDeadline<T>(work: Promise<T>, ms: number, label = "timed out"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([work, limit]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
