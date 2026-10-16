import { describe, expect, it } from "vitest";
import { STALE_FACTOR, TtlCache, withDeadline } from "../src/dashboard/home/cache";

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("TtlCache", () => {
  it("serves a fresh value without loading again", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    let loads = 0;
    const load = async () => ++loads;
    expect(await cache.get("k", 100, load)).toBe(1);
    c.advance(99);
    expect(await cache.get("k", 100, load)).toBe(1);
    c.advance(1);
    expect(await cache.get("k", 100, load)).toBe(2);
  });

  it("keeps keys apart", async () => {
    const cache = new TtlCache(clock().now);
    expect(await cache.get("a", 100, async () => "a")).toBe("a");
    expect(await cache.get("b", 100, async () => "b")).toBe("b");
  });

  it("runs one load at a time per key (single flight)", async () => {
    const cache = new TtlCache(clock().now);
    let loads = 0;
    let release: (v: number) => void = () => undefined;
    const gate = new Promise<number>((r) => (release = r));
    const load = async () => {
      loads++;
      return gate;
    };
    const all = Promise.all([cache.get("k", 100, load), cache.get("k", 100, load), cache.get("k", 100, load)]);
    release(7);
    expect(await all).toEqual([7, 7, 7]);
    expect(loads).toBe(1);
  });

  it("serves the last good value when a refresh fails, until it is 5x the TTL old", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    await cache.get("k", 100, async () => "good");
    const fail = async (): Promise<string> => {
      throw new Error("down");
    };
    c.advance(150);
    expect(await cache.get("k", 100, fail)).toBe("good");
    c.advance(100 * STALE_FACTOR - 150);
    expect(await cache.get("k", 100, fail)).toBe("good");
    c.advance(1);
    await expect(cache.get("k", 100, fail)).rejects.toThrow("down");
  });

  it("throws when there is nothing to fall back to, and then tries again", async () => {
    const cache = new TtlCache(clock().now);
    await expect(
      cache.get("k", 100, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await cache.get("k", 100, async () => "fine")).toBe("fine");
  });

  it("clear forgets a key", async () => {
    const cache = new TtlCache(clock().now);
    await cache.get("k", 100, async () => 1);
    cache.clear("k");
    expect(await cache.get("k", 100, async () => 2)).toBe(2);
  });
});

describe("TtlCache failure memory and deadline", () => {
  const boom = async (): Promise<string> => {
    throw new Error("down");
  };

  it("by default tries again straight after a failure", async () => {
    const cache = new TtlCache(clock().now);
    let loads = 0;
    const flaky = async () => {
      loads++;
      throw new Error("down");
    };
    await expect(cache.get("k", 100, flaky)).rejects.toThrow("down");
    await expect(cache.get("k", 100, flaky)).rejects.toThrow("down");
    expect(loads).toBe(2);
  });

  it("with failTtlMs, remembers a failure and answers at once instead of asking the dead dependency again", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    let loads = 0;
    const down = async () => {
      loads++;
      throw new Error("down");
    };
    await expect(cache.get("k", 100, down, { failTtlMs: 50 })).rejects.toThrow("down");
    c.advance(10);
    await expect(cache.get("k", 100, down, { failTtlMs: 50 })).rejects.toThrow("down");
    expect(loads).toBe(1);
    c.advance(50);
    await expect(cache.get("k", 100, down, { failTtlMs: 50 })).rejects.toThrow("down");
    expect(loads).toBe(2);
  });

  it("a success ends the failure window", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    await expect(cache.get("k", 100, boom, { failTtlMs: 1000 })).rejects.toThrow();
    c.advance(1001);
    expect(await cache.get("k", 100, async () => "ok", { failTtlMs: 1000 })).toBe("ok");
    expect(await cache.get("k", 100, boom, { failTtlMs: 1000 })).toBe("ok");
  });

  it("serves the last good value through a failure window", async () => {
    const c = clock();
    const cache = new TtlCache(c.now);
    await cache.get("k", 100, async () => "good");
    c.advance(150);
    expect(await cache.get("k", 100, boom, { failTtlMs: 500 })).toBe("good");
    c.advance(10);
    expect(await cache.get("k", 100, async () => "never loaded", { failTtlMs: 500 })).toBe("good");
  });

  it("deadlineMs stops a caller waiting, remembers the miss, and still fills the cache when the load finishes", async () => {
    const cache = new TtlCache();
    let release: (v: string) => void = () => undefined;
    let loads = 0;
    const slow = () => {
      loads++;
      return new Promise<string>((r) => (release = r));
    };
    const t0 = Date.now();
    await expect(cache.get("k", 10_000, slow, { deadlineMs: 30, failTtlMs: 10_000 })).rejects.toThrow("timed out");
    expect(Date.now() - t0).toBeLessThan(500);
    // Inside the window the next caller is told at once and no second load starts.
    const t1 = Date.now();
    await expect(cache.get("k", 10_000, slow, { deadlineMs: 30, failTtlMs: 10_000 })).rejects.toThrow("timed out");
    expect(Date.now() - t1).toBeLessThan(20);
    expect(loads).toBe(1);
    // The load finishes after all: its value is kept and the failure forgotten.
    release("late");
    await new Promise((r) => setTimeout(r, 10));
    expect(await cache.get("k", 10_000, slow, { deadlineMs: 30, failTtlMs: 10_000 })).toBe("late");
  });

  it("holds at most maxEntries keys, dropping expired ones first", async () => {
    const c = clock();
    const cache = new TtlCache(c.now, 3);
    for (const k of ["a", "b", "c"]) await cache.get(k, 10, async () => k);
    c.advance(10 * STALE_FACTOR + 1); // all three are now beyond use
    await cache.get("d", 10, async () => "d");
    let loads = 0;
    await cache.get("a", 10, async () => ++loads);
    expect(loads).toBe(1); // "a" had been swept, so it loaded again
    // Over the limit with nothing expired: the oldest goes.
    const tight = new TtlCache(c.now, 2);
    for (const k of ["x", "y", "z"]) await tight.get(k, 1000, async () => k);
    let again = 0;
    await tight.get("x", 1000, async () => ++again);
    expect(again).toBe(1);
  });
});

describe("withDeadline", () => {
  it("resolves with the work when it is quick", async () => {
    expect(await withDeadline(Promise.resolve(5), 50)).toBe(5);
  });
  it("rejects when the work is slow", async () => {
    await expect(withDeadline(new Promise(() => undefined), 10, "too slow")).rejects.toThrow("too slow");
  });
});
