import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "../src/settings/settings.service";
import type { Db } from "../src/db/db.module";
import type { ClusterBus } from "../src/cluster/cluster-bus.service";

// A database whose answers the test controls: each query waits on a promise it can settle.
function fakeDb() {
  const pending: Array<{ resolve: (rows: unknown[]) => void; reject: (e: Error) => void }> = [];
  let queries = 0;
  const query = () => {
    queries++;
    return new Promise<unknown[]>((resolve, reject) => pending.push({ resolve, reject }));
  };
  const db = { select: () => ({ from: () => ({ where: () => ({ limit: query }) }) }) } as unknown as Db;
  return { db, pending, queries: () => queries };
}
const service = (db: Db) => new SettingsService(db, { onEvent: () => undefined } as unknown as ClusterBus);

describe("SettingsService.get when the database stops answering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the database when it has nothing to fall back on", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const p = s.get("site.name");
    f.pending[0]!.resolve([{ value: "Church" }]);
    await expect(p).resolves.toBe("Church");
  });

  it("serves the old value instead of stalling once the entry has expired and the database hangs", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const first = s.get("auth.rate_limit_per_minute");
    f.pending[0]!.resolve([{ value: 900 }]);
    await first;

    vi.advanceTimersByTime(61_000); // expired
    const second = s.get("auth.rate_limit_per_minute"); // starts the refresh; the database hangs
    await vi.advanceTimersByTimeAsync(1_600);
    await expect(second).resolves.toBe(900);
  });

  it("answers further reads at once while that refresh is still stuck, with one query in flight", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const first = s.get("k");
    f.pending[0]!.resolve([{ value: 1 }]);
    await first;
    vi.advanceTimersByTime(61_000);

    void s.get("k"); // starts the stuck refresh
    await vi.advanceTimersByTimeAsync(1_600);
    const queriesBefore = f.queries();
    // These must not wait for any timer nor start more queries.
    await expect(Promise.all([s.get("k"), s.get("k"), s.get("k")])).resolves.toEqual([1, 1, 1]);
    expect(f.queries()).toBe(queriesBefore);
  });

  it("takes the new value when the stuck refresh finally answers", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const first = s.get("k");
    f.pending[0]!.resolve([{ value: 1 }]);
    await first;
    vi.advanceTimersByTime(61_000);

    void s.get("k");
    await vi.advanceTimersByTimeAsync(1_600);
    f.pending[1]!.resolve([{ value: 2 }]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(s.get("k")).resolves.toBe(2);
  });

  it("serves the old value when the refresh fails outright, and tries again on the next read", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const first = s.get("k");
    f.pending[0]!.resolve([{ value: 1 }]);
    await first;
    vi.advanceTimersByTime(61_000);

    const second = s.get("k");
    f.pending[1]!.reject(new Error("connection terminated"));
    await expect(second).resolves.toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    void s.get("k");
    expect(f.queries()).toBe(3);
  });

  it("still fails for a key it never had, so callers keep their own fallback", async () => {
    const f = fakeDb();
    const s = service(f.db);
    const p = s.get("never-read");
    f.pending[0]!.reject(new Error("down"));
    await expect(p).rejects.toThrow("down");
  });
});
