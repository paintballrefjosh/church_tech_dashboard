/**
 * A tiny per-node TTL cache with single-flight, for reads of external systems (the UniFi
 * controller, Technitium, Planning Center) that every open home page would otherwise repeat.
 *
 * - A value younger than the TTL is returned as is.
 * - Otherwise one load runs per key, however many callers ask meanwhile.
 * - If that load fails, the last good value is served until it is older than `STALE_FACTOR` times
 *   the TTL; after that the error is thrown.
 *
 * It is lazy (no timers) and holds only reads of other systems, so it never needs invalidating
 * across nodes.
 */
export const STALE_FACTOR = 5;

interface Entry<T> {
  value: T;
  at: number;
}

export class TtlCache {
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly clock: () => number = Date.now) {}

  async get<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key) as Entry<T> | undefined;
    if (hit && this.clock() - hit.at < ttlMs) return hit.value;

    let flight = this.inflight.get(key) as Promise<T> | undefined;
    if (!flight) {
      flight = load().then(
        (value) => {
          this.entries.set(key, { value, at: this.clock() });
          this.inflight.delete(key);
          return value;
        },
        (err: unknown) => {
          this.inflight.delete(key);
          throw err;
        },
      );
      this.inflight.set(key, flight);
    }
    try {
      return await flight;
    } catch (err) {
      const last = this.entries.get(key) as Entry<T> | undefined;
      if (last && this.clock() - last.at <= ttlMs * STALE_FACTOR) return last.value;
      throw err;
    }
  }

  /** Forget one key, or everything. */
  clear(key?: string): void {
    if (key === undefined) this.entries.clear();
    else this.entries.delete(key);
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
