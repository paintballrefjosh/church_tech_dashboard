import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { BUS_POLL_MS, ClusterBus } from "../src/cluster/cluster-bus.service";
import { CONSISTENCY_COOKIE, consistencyCookie, parseConsistencyCookie, registerReadYourWrites } from "../src/cluster/read-your-writes";
import { MemoryBusStore } from "./helpers/memory-bus-store";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";
import type { NodeService } from "../src/cluster/node.service";

function makeBus(store: MemoryBusStore, nodeId: string) {
  const node = { identity: { nodeId, instanceId: `${nodeId}-i`, holder: `${nodeId}/i`, role: "full", addr: null, backgroundJobs: true } } as unknown as NodeService;
  const bus = new ClusterBus(store, node, { register: vi.fn() } as unknown as ClusterJobs);
  const got: string[] = [];
  bus.onEvent((r) => void got.push(`${r.room}:${r.event}`));
  bus.onModuleInit();
  return { bus, got };
}

describe("the read-your-writes cookie", () => {
  const now = 1_800_000_000_000;

  it("is read from a cookie header among others", () => {
    expect(parseConsistencyCookie(`a=1; ${CONSISTENCY_COOKIE}=${now - 2000}; b=2`, now)).toBe(now - 2000);
    expect(parseConsistencyCookie(undefined, now)).toBeNull();
    expect(parseConsistencyCookie("a=1", now)).toBeNull();
  });

  it("ignores a value that is not a believable recent time", () => {
    expect(parseConsistencyCookie(`${CONSISTENCY_COOKIE}=abc`, now)).toBeNull();
    expect(parseConsistencyCookie(`${CONSISTENCY_COOKIE}=${now - 120_000}`, now)).toBeNull(); // long ago
    expect(parseConsistencyCookie(`${CONSISTENCY_COOKIE}=${now + 60_000}`, now)).toBeNull(); // far future
    expect(parseConsistencyCookie(`${CONSISTENCY_COOKIE}=${now + 1000}`, now)).toBe(now + 1000); // a little clock skew is fine
  });

  it("is a short-lived HttpOnly Lax cookie, never Secure (HTTPS is upstream)", () => {
    const c = consistencyCookie(123);
    expect(c).toMatch(/^church_rv=123; Path=\/; Max-Age=10; HttpOnly; SameSite=Lax$/);
    expect(c).not.toMatch(/Secure/i);
  });
});

describe("ClusterBus.syncSince", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("delivers another node's event at once instead of at its next poll", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await vi.advanceTimersByTimeAsync(BUS_POLL_MS + 10); // both have taken their baseline poll

    a.bus.publish({ room: "__cache", event: "user", payload: { id: "u1" } });
    await a.bus.flushNow();
    const wrote = Date.now();
    await vi.advanceTimersByTimeAsync(300); // well before B's next poll is due
    expect(b.got).toEqual([]);

    await b.bus.syncSince(wrote);
    expect(b.got).toEqual(["__cache:user"]);
  });

  it("does nothing extra when a poll has started since the write", async () => {
    const store = new MemoryBusStore();
    const spy = vi.spyOn(store, "fetch");
    const b = makeBus(store, "b");
    await vi.advanceTimersByTimeAsync(BUS_POLL_MS + 10);
    const calls = spy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BUS_POLL_MS); // a poll after the "write" below
    await b.bus.syncSince(Date.now() - BUS_POLL_MS - 400);
    expect(spy.mock.calls.length).toBe(calls + 1); // just the timer's own
  });

  it("shares one forced poll between requests that arrive together", async () => {
    const store = new MemoryBusStore();
    const spy = vi.spyOn(store, "fetch");
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await vi.advanceTimersByTimeAsync(BUS_POLL_MS + 10);
    a.bus.publish({ room: "r", event: "e" });
    await a.bus.flushNow();
    const wrote = Date.now();
    await vi.advanceTimersByTimeAsync(300);
    const before = spy.mock.calls.length;
    await Promise.all([b.bus.syncSince(wrote), b.bus.syncSince(wrote), b.bus.syncSince(wrote), b.bus.syncSince(wrote)]);
    expect(spy.mock.calls.length - before).toBe(1);
    expect(b.got).toEqual(["r:e"]);
  });

  it("gives up waiting when the database is slow, rather than hold a request", async () => {
    const store = new MemoryBusStore();
    const b = makeBus(store, "b");
    await vi.advanceTimersByTimeAsync(BUS_POLL_MS + 10);
    vi.spyOn(store, "fetch").mockImplementation(() => new Promise(() => undefined));
    const done = vi.fn();
    void b.bus.syncSince(Date.now()).then(done);
    await vi.advanceTimersByTimeAsync(1600);
    expect(done).toHaveBeenCalled();
  });
});

describe("the hooks", () => {
  it("flush invalidations before a change is answered and add the cookie; reads get none; a request with the cookie syncs first", async () => {
    const store = new MemoryBusStore();
    const { bus } = makeBus(store, "a");
    const flush = vi.spyOn(bus, "flushNow");
    const sync = vi.spyOn(bus, "syncSince").mockResolvedValue();
    const app = Fastify();
    registerReadYourWrites(app, bus, true);
    app.post("/change", async () => ({ ok: true }));
    app.get("/read", async () => ({ ok: true }));

    const write = await app.inject({ method: "POST", url: "/change" });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(String(write.headers["set-cookie"])).toMatch(/church_rv=\d+; Path=\/; Max-Age=10/);

    const read = await app.inject({ method: "GET", url: "/read" });
    expect(read.headers["set-cookie"]).toBeUndefined();
    expect(sync).not.toHaveBeenCalled();

    const stamp = Date.now() - 100;
    await app.inject({ method: "GET", url: "/read", headers: { cookie: `church_rv=${stamp}` } });
    expect(sync).toHaveBeenCalledWith(stamp);
    await app.close();
    await bus.onModuleDestroy();
  });

  it("do nothing at all outside a cluster", async () => {
    const store = new MemoryBusStore();
    const { bus } = makeBus(store, "a");
    const app = Fastify();
    registerReadYourWrites(app, bus, false);
    app.post("/change", async () => ({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/change" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    await app.close();
    await bus.onModuleDestroy();
  });
});
