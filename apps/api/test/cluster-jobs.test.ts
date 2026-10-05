import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterJobs, LEASE_RENEW_MS } from "../src/cluster/cluster-jobs.service";
import { JOB_LEASE_TTL_SEC, LeaseService } from "../src/cluster/lease.service";
import type { LeaseStore } from "../src/cluster/lease.store";
import type { NodeService } from "../src/cluster/node.service";

/**
 * In-memory stand-in for the database lease table, with the same rules as the SQL
 * in lease.store.ts: a lease changes hands only when free, expired or already the
 * caller's; the epoch rises on every change of holder; time is the store's own
 * clock (here, the faked Date), never the caller's.
 */
class MemoryLeaseStore implements LeaseStore {
  private rows = new Map<string, { holder: string; epoch: number; expiresAt: number }>();
  /** When set, every call fails, like an unreachable database. */
  down = false;

  async acquire(name: string, holder: string, ttlSec: number) {
    if (this.down) throw new Error("db down");
    const now = Date.now();
    const row = this.rows.get(name);
    if (!row) {
      this.rows.set(name, { holder, epoch: 1, expiresAt: now + ttlSec * 1000 });
      return { epoch: 1 };
    }
    if (row.holder === holder || row.expiresAt < now) {
      const epoch = row.holder === holder ? row.epoch : row.epoch + 1;
      this.rows.set(name, { holder, epoch, expiresAt: now + ttlSec * 1000 });
      return { epoch };
    }
    return null;
  }

  async release(name: string, holder: string) {
    if (this.down) throw new Error("db down");
    const row = this.rows.get(name);
    if (row && row.holder === holder) row.expiresAt = Date.now() - 1000;
  }

  holderOf(name: string): string | null {
    const row = this.rows.get(name);
    return row && row.expiresAt >= Date.now() ? row.holder : null;
  }
}

function node(id: string, backgroundJobs = true): NodeService {
  return { identity: { nodeId: id, instanceId: `${id}-inst`, holder: `${id}/inst`, role: "full", addr: null, backgroundJobs } } as unknown as NodeService;
}

function makeNode(store: LeaseStore, id: string, backgroundJobs = true) {
  const n = node(id, backgroundJobs);
  const leases = new LeaseService(store, n);
  const jobs = new ClusterJobs(leases, n);
  // Fake timers do not move node:perf_hooks, so tie the monotonic clock to the faked Date.
  jobs.clock = () => Date.now();
  return { leases, jobs, node: n };
}

/** Let pending promise callbacks (lease round trips) run. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LeaseService", () => {
  it("lets only one holder have a mutex at a time, including twice in one process", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const b = makeNode(store, "b");

    const first = await a.leases.acquireMutex("dns-sync", 120);
    expect(first).not.toBeNull();
    expect(await a.leases.acquireMutex("dns-sync", 120)).toBeNull(); // same process, still excluded
    expect(await b.leases.acquireMutex("dns-sync", 120)).toBeNull(); // other node

    await first!.release();
    const again = await b.leases.acquireMutex("dns-sync", 120);
    expect(again).not.toBeNull();
    await again!.release();
  });

  it("withMutex reports ran:false instead of running when the mutex is taken", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const held = await a.leases.acquireMutex("x", 60);
    let ran = false;
    const res = await a.leases.withMutex("x", 60, async () => {
      ran = true;
    });
    expect(res).toEqual({ ran: false });
    expect(ran).toBe(false);
    await held!.release();
  });

  it("withMutex releases the mutex when the work throws", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    await expect(
      a.leases.withMutex("x", 60, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(store.holderOf("mutex:x")).toBeNull();
  });

  it("renews a mutex while the work runs, and flags it lost if another holder takes it", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const mutex = await a.leases.acquireMutex("long", 30);
    expect(mutex).not.toBeNull();

    // Still held well past the TTL because it keeps renewing.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(store.holderOf("mutex:long")).not.toBeNull();
    expect(mutex!.lost).toBe(false);
    await mutex!.release();
  });

  it("releaseAll gives up job leases so another node can take them at once", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const b = makeNode(store, "b");
    expect(await a.leases.acquire("job:x", JOB_LEASE_TTL_SEC)).not.toBeNull();
    expect(await b.leases.acquire("job:x", JOB_LEASE_TTL_SEC)).toBeNull();
    await a.leases.releaseAll();
    expect(await b.leases.acquire("job:x", JOB_LEASE_TTL_SEC)).toEqual({ epoch: 2 });
  });
});

describe("ClusterJobs", () => {
  it("runs a job only on the node that holds its lease", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const b = makeNode(store, "b");
    const runsA = vi.fn(async () => undefined);
    const runsB = vi.fn(async () => undefined);

    a.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: runsA });
    await settle();
    b.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: runsB });
    await settle();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(a.jobs.isLeader("poll")).toBe(true);
    expect(b.jobs.isLeader("poll")).toBe(false);
    expect(runsA.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(runsB).not.toHaveBeenCalled();

    await a.jobs.onModuleDestroy();
    await b.jobs.onModuleDestroy();
  });

  it("moves a job to another node within about a lease TTL when the leader stops renewing", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const b = makeNode(store, "b");
    const runsB = vi.fn(async () => undefined);

    a.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: async () => undefined });
    await settle();
    b.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: runsB });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(runsB).not.toHaveBeenCalled();

    // The leader dies without releasing anything: stop its timers (as a crash would).
    await a.jobs.onModuleDestroy();

    await vi.advanceTimersByTimeAsync((JOB_LEASE_TTL_SEC + LEASE_RENEW_MS / 1000 + 5) * 1000);
    expect(b.jobs.isLeader("poll")).toBe(true);
    expect(runsB).toHaveBeenCalled();
    await b.jobs.onModuleDestroy();
  });

  it("hands over at once when the leader shuts down cleanly", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const b = makeNode(store, "b");
    a.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: async () => undefined });
    await settle();
    b.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: async () => undefined });
    await settle();
    expect(a.jobs.isLeader("poll")).toBe(true);

    await a.jobs.onModuleDestroy();
    await a.leases.releaseAll();
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS + 1);
    expect(b.jobs.isLeader("poll")).toBe(true);
    await b.jobs.onModuleDestroy();
  });

  it("stops acting as leader when the database goes away and the claim lapses", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    const runs = vi.fn(async () => undefined);
    a.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: runs });
    await settle();
    expect(a.jobs.isLeader("poll")).toBe(true);

    store.down = true;
    // Still leader for a while on the strength of the last successful renewal...
    await vi.advanceTimersByTimeAsync(10_000);
    expect(a.jobs.isLeader("poll")).toBe(true);
    // ...but not once the TTL has passed with no renewal getting through.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.jobs.isLeader("poll")).toBe(false);
    const callsWhenLapsed = runs.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runs.mock.calls.length).toBe(callsWhenLapsed);

    // Database back: leadership is regained.
    store.down = false;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_MS + 1);
    expect(a.jobs.isLeader("poll")).toBe(true);
    await a.jobs.onModuleDestroy();
  });

  it("never leads when BACKGROUND_JOBS is off", async () => {
    const store = new MemoryLeaseStore();
    const off = makeNode(store, "off", false);
    const on = makeNode(store, "on");
    const runsOff = vi.fn(async () => undefined);
    off.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: runsOff });
    on.jobs.register({ name: "poll", everyMs: 5_000, initialDelayMs: 1_000, run: async () => undefined });
    await settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(off.jobs.isLeader("poll")).toBe(false);
    expect(runsOff).not.toHaveBeenCalled();
    expect(on.jobs.isLeader("poll")).toBe(true);
    await off.jobs.onModuleDestroy();
    await on.jobs.onModuleDestroy();
  });

  it("fixed-rate lets a slow run overlap the next; fixed-delay waits for it to finish", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    let rateStarts = 0;
    let delayStarts = 0;
    const slow = (count: () => void) => async () => {
      count();
      await new Promise((r) => setTimeout(r, 12_000));
    };
    a.jobs.register({ name: "rate", everyMs: 5_000, initialDelayMs: 1_000, run: slow(() => rateStarts++) });
    a.jobs.register({ name: "delay", everyMs: 5_000, initialDelayMs: 1_000, schedule: "fixed-delay", run: slow(() => delayStarts++) });
    await settle();

    await vi.advanceTimersByTimeAsync(30_000);
    // rate: starts at 1s, 6s, 11s, 16s, 21s, 26s. delay: 1s, then 12s run + 5s wait = every 17s.
    expect(rateStarts).toBeGreaterThanOrEqual(5);
    expect(delayStarts).toBeLessThanOrEqual(2);
    // Shutdown waits for the runs still in flight, so let the clock run while it does.
    const stopping = a.jobs.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(15_000);
    await stopping;
  });

  it("re-reads a function cadence before every wait", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    let every = 5_000;
    const run = vi.fn(async () => undefined);
    a.jobs.register({ name: "tunable", everyMs: () => every, initialDelayMs: 1_000, schedule: "fixed-delay", run });
    await settle();
    await vi.advanceTimersByTimeAsync(1_000); // first run
    expect(run).toHaveBeenCalledTimes(1);
    every = 60_000;
    await vi.advanceTimersByTimeAsync(5_000); // second run, scheduled with the old cadence
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000); // next one is now 60s out
    expect(run).toHaveBeenCalledTimes(2);
    await a.jobs.onModuleDestroy();
  });

  it("a failing run is logged and the job keeps running", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    let n = 0;
    a.jobs.register({
      name: "flaky",
      everyMs: 5_000,
      initialDelayMs: 1_000,
      run: async () => {
        n++;
        throw new Error("nope");
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(n).toBeGreaterThanOrEqual(3);
    await a.jobs.onModuleDestroy();
  });

  it("on shutdown waits for a running job to finish, then releases its lease", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    let finished = false;
    a.jobs.register({
      name: "slow",
      everyMs: 5_000,
      initialDelayMs: 1_000,
      run: async () => {
        await new Promise((r) => setTimeout(r, 3_000));
        finished = true;
      },
    });
    await settle();
    await vi.advanceTimersByTimeAsync(1_500); // the run has started

    let destroyed = false;
    const stopping = a.jobs.onModuleDestroy().then(() => {
      destroyed = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(finished).toBe(false);
    expect(destroyed).toBe(false); // still waiting
    expect(store.holderOf("job:slow")).not.toBeNull(); // lease not handed over mid-run

    await vi.advanceTimersByTimeAsync(2_500);
    await stopping;
    expect(finished).toBe(true);
    expect(store.holderOf("job:slow")).toBeNull(); // now released
  });

  it("on shutdown gives up on a job that never finishes", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    a.jobs.register({ name: "stuck", everyMs: 5_000, initialDelayMs: 1_000, run: () => new Promise(() => undefined) });
    await settle();
    await vi.advanceTimersByTimeAsync(1_500);
    const stopping = a.jobs.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(7_000);
    await stopping;
    expect(store.holderOf("job:stuck")).toBeNull();
  });

  it("a job that throws synchronously is treated like one that rejects", async () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    let n = 0;
    a.jobs.register({
      name: "sync-throw",
      everyMs: 5_000,
      initialDelayMs: 1_000,
      run: (() => {
        n++;
        throw new Error("sync boom");
      }) as () => Promise<void>,
    });
    await settle();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(n).toBeGreaterThanOrEqual(2);
    await a.jobs.onModuleDestroy();
  });

  it("refuses to register the same job twice", () => {
    const store = new MemoryLeaseStore();
    const a = makeNode(store, "a");
    a.jobs.register({ name: "dup", everyMs: 5_000, run: async () => undefined });
    expect(() => a.jobs.register({ name: "dup", everyMs: 5_000, run: async () => undefined })).toThrow(/already registered/);
    void a.jobs.onModuleDestroy();
  });
});
