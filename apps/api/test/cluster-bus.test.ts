import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUS_POLL_MS, ClusterBus, MAX_EVENT_BYTES } from "../src/cluster/cluster-bus.service";
import type { BusRow } from "../src/cluster/bus.store";
import { MemoryBusStore } from "./helpers/memory-bus-store";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";
import type { NodeService } from "../src/cluster/node.service";

function makeBus(store: MemoryBusStore, nodeId: string) {
  const node = { identity: { nodeId, instanceId: `${nodeId}-i`, holder: `${nodeId}/i`, role: "full", addr: null, backgroundJobs: true } } as unknown as NodeService;
  const jobs = { register: vi.fn() } as unknown as ClusterJobs;
  const bus = new ClusterBus(store, node, jobs);
  const got: BusRow[] = [];
  bus.onEvent((r) => void got.push(r));
  bus.onModuleInit();
  return { bus, got };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("ClusterBus events", () => {
  it("delivers an event to the other nodes but not back to the sender", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10); // both take their first poll baseline

    a.bus.publish({ room: "user:1", event: "notification:new", payload: { n: 1 } });
    await advance(BUS_POLL_MS * 2);

    expect(b.got.map((r) => [r.room, r.event, r.payload])).toEqual([["user:1", "notification:new", { n: 1 }]]);
    expect(a.got).toHaveLength(0);
  });

  it("keeps one sender's events in the order they were published", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    for (let i = 1; i <= 5; i++) a.bus.publish({ room: "r", event: "e", payload: { i } });
    await advance(BUS_POLL_MS * 2);

    expect(b.got.map((r) => (r.payload as { i: number }).i)).toEqual([1, 2, 3, 4, 5]);
  });

  it("delivers an event once even though polls overlap", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    a.bus.publish({ room: "r", event: "e", payload: 1 });
    await advance(BUS_POLL_MS * 10); // many polls all still within the look-back window
    expect(b.got).toHaveLength(1);
  });

  it("does not replay events that were published before the node started", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    await advance(BUS_POLL_MS + 10);
    a.bus.publish({ room: "r", event: "old", payload: 1 });
    await advance(BUS_POLL_MS * 2);

    const late = makeBus(store, "late");
    await advance(BUS_POLL_MS * 3);
    expect(late.got).toHaveLength(0);
  });

  it("still sees an event whose insert committed slightly after a later poll started", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS * 10);

    // A row stamped 2s ago appears now, as if its transaction committed late.
    store.insertAt(
      { id: "late-1", originNode: "a/i", seq: 99, room: "r", event: "e", payload: 1, ref: null },
      new Date(Date.now() - 2_000),
    );
    await advance(BUS_POLL_MS * 2);
    expect(b.got.map((r) => r.id)).toContain("late-1");
    void a;
  });

  it("does not send an event over the size limit, and keeps working", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    a.bus.publish({ room: "r", event: "big", payload: "x".repeat(MAX_EVENT_BYTES + 1) });
    a.bus.publish({ room: "r", event: "small", payload: 1 });
    await advance(BUS_POLL_MS * 2);
    expect(b.got.map((r) => r.event)).toEqual(["small"]);
  });

  it("delivers a large burst completely, across fetch pages", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    for (let i = 0; i < 2500; i++) a.bus.publish({ room: "r", event: "e", payload: { i } });
    await advance(BUS_POLL_MS * 6);
    const seen = new Set(b.got.map((r) => (r.payload as { i: number }).i));
    expect(seen.size).toBe(2500);
  });

  it("survives the database going away and delivers what was published once it is back", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    store.down = true;
    await advance(BUS_POLL_MS * 5); // polls fail quietly
    store.down = false;
    a.bus.publish({ room: "r", event: "after", payload: 1 });
    await advance(BUS_POLL_MS * 3);
    expect(b.got.map((r) => r.event)).toEqual(["after"]);
  });

  it("registers a prune job", () => {
    const store = new MemoryBusStore();
    const node = { identity: { nodeId: "a", instanceId: "i", holder: "a/i" } } as unknown as NodeService;
    const jobs = { register: vi.fn() };
    new ClusterBus(store, node, jobs as unknown as ClusterJobs).onModuleInit();
    expect(jobs.register).toHaveBeenCalledWith(expect.objectContaining({ name: "bus-prune" }));
  });
});

describe("ClusterBus presence and snapshots", () => {
  it("tells other nodes which rooms have viewers, and clears it when the viewers go", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    let rooms = new Map<string, number>([["network", 2]]);
    a.bus.setPresenceSource(() => rooms);
    await advance(BUS_POLL_MS + 10);

    expect(b.bus.remoteViewers("network")).toBe(false);
    a.bus.touchPresence();
    await advance(BUS_POLL_MS * 2);
    expect(b.bus.remoteViewers("network")).toBe(true);
    expect(b.bus.remoteViewers("infra")).toBe(false);
    expect(a.bus.remoteViewers("network")).toBe(false); // its own viewers are not "remote"

    rooms = new Map();
    a.bus.touchPresence();
    await advance(BUS_POLL_MS * 2);
    expect(b.bus.remoteViewers("network")).toBe(false);
  });

  it("stops counting a node whose presence has not been refreshed", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    a.bus.setPresenceSource(() => new Map([["network", 1]]));
    a.bus.touchPresence();
    await advance(BUS_POLL_MS * 2);
    expect(b.bus.remoteViewers("network")).toBe(true);

    // Node a dies: no more refreshes.
    await a.bus.onModuleDestroy();
    store.presence.set("a", { rooms: new Map([["network", 1]]), at: Date.now() }); // a crash leaves its row behind
    await advance(30_000);
    expect(b.bus.remoteViewers("network")).toBe(false);
  });

  it("publishSnapshot stores the payload once and sends a pointer to it", async () => {
    const store = new MemoryBusStore();
    const a = makeBus(store, "a");
    const b = makeBus(store, "b");
    await advance(BUS_POLL_MS + 10);

    await a.bus.publishSnapshot("network", "network:snapshot", "unifi:network", { devices: [1, 2, 3] });
    await advance(BUS_POLL_MS * 2);

    expect(b.got).toHaveLength(1);
    expect(b.got[0]!.payload).toBeNull();
    expect(b.got[0]!.ref).toBe("unifi:network");
    expect(await b.bus.readSnapshot("unifi:network")).toEqual({ devices: [1, 2, 3] });
  });
});
