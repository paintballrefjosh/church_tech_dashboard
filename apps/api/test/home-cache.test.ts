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

describe("withDeadline", () => {
  it("resolves with the work when it is quick", async () => {
    expect(await withDeadline(Promise.resolve(5), 50)).toBe(5);
  });
  it("rejects when the work is slow", async () => {
    await expect(withDeadline(new Promise(() => undefined), 10, "too slow")).rejects.toThrow("too slow");
  });
});
