import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClusterBus, BUS_POLL_MS } from "../src/cluster/cluster-bus.service";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";
import type { NodeService } from "../src/cluster/node.service";
import { SearchService, searchDocId, type SearchDoc } from "../src/search/search.service";
import type { SearchSources } from "../src/search/search-sources";
import type { LiveSearchStore } from "../src/search/live-search.store";
import { diffDocs, docRev, withRev } from "../src/search/search-helpers";
import { MemoryBusStore } from "./helpers/memory-bus-store";

/** A Meilisearch index in memory: just enough of the API the service uses. */
const fake = vi.hoisted(() => {
  class FakeIndex {
    docs = new Map<string, Record<string, unknown>>();
    adds: number[] = [];
    deletes: string[][] = [];
    async updateFilterableAttributes() {}
    async updateSortableAttributes() {}
    async updateSearchableAttributes() {}
    async getDocuments(opts: { filter: string; limit: number; offset: number }) {
      const kinds = [...opts.filter.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
      const all = [...this.docs.values()].filter((d) => kinds.includes(d.kind as string)).map((d) => ({ id: d.id, rev: d.rev }));
      return { results: all.slice(opts.offset, opts.offset + opts.limit) };
    }
    async addDocuments(docs: Array<Record<string, unknown>>) {
      this.adds.push(docs.length);
      for (const d of docs) this.docs.set(d.id as string, d);
      return { taskUid: 1 };
    }
    async deleteDocuments(ids: string[]) {
      this.deletes.push(ids);
      for (const id of ids) this.docs.delete(id);
      return { taskUid: 1 };
    }
    async deleteDocument(id: string) {
      this.docs.delete(id);
      return { taskUid: 1 };
    }
    async deleteAllDocuments() {
      this.docs.clear();
      return { taskUid: 1 };
    }
    async search() {
      return { hits: [...this.docs.values()] };
    }
  }
  const indexes = new Map<string, FakeIndex>();
  return { FakeIndex, indexes };
});

vi.mock("meilisearch", () => ({
  MeiliSearch: class {
    constructor(private readonly opts: { host: string }) {}
    async createIndex() {
      return { taskUid: 1 };
    }
    async waitForTask() {
      return { status: "succeeded" };
    }
    index() {
      if (!fake.indexes.has(this.opts.host)) fake.indexes.set(this.opts.host, new fake.FakeIndex());
      return fake.indexes.get(this.opts.host);
    }
  },
}));

// ---- the database side, in memory and shared by every node ----

class FakeSources implements SearchSources {
  tickets = new Map<string, SearchDoc>();
  notes = new Map<string, SearchDoc>();
  wiki = new Map<string, SearchDoc>();
  monitoring: SearchDoc[] = [];
  private map(kind: string) {
    return kind === "ticket" ? this.tickets : kind === "note" ? this.notes : this.wiki;
  }
  async loadContentDoc(kind: "ticket" | "note" | "wiki", id: string) {
    return this.map(kind).get(id) ?? null;
  }
  async loadContentDocs(kind: "ticket" | "note" | "wiki") {
    return [...this.map(kind).values()];
  }
  async loadMonitoringDocs() {
    return this.monitoring;
  }
  put(kind: "ticket" | "note" | "wiki", id: string, title: string, over: Partial<SearchDoc> = {}) {
    this.map(kind).set(id, {
      id: searchDocId(kind, id),
      kind,
      resourceId: id,
      ownerUserId: "u1",
      title,
      body: `${title} body`,
      updatedAt: "2026-10-04T12:00:00.000Z",
      ...over,
    });
  }
}

class FakeLive implements LiveSearchStore {
  rows = new Map<string, SearchDoc>();
  replaces = 0;
  async replace(kinds: string[], docs: SearchDoc[]) {
    this.replaces++;
    const want = new Map(docs.map((d) => [d.id, withRev(d)]));
    let changed = false;
    for (const [id, row] of [...this.rows]) {
      if (kinds.includes(row.kind) && !want.has(id)) {
        this.rows.delete(id);
        changed = true;
      }
    }
    for (const [id, d] of want) {
      if (this.rows.get(id)?.rev !== d.rev) {
        this.rows.set(id, d);
        changed = true;
      }
    }
    return changed;
  }
  async load(kinds: string[]) {
    return [...this.rows.values()].filter((d) => kinds.includes(d.kind));
  }
}

const doc = (kind: SearchDoc["kind"], id: string, title: string): SearchDoc => ({
  id: searchDocId(kind, id),
  kind,
  resourceId: id,
  title,
  body: "",
  updatedAt: "2026-10-04T12:00:00.000Z",
});

function makeNode(name: string, shared: { bus: MemoryBusStore; sources: FakeSources; live: FakeLive }, withMeili = true) {
  const node = { identity: { nodeId: name, instanceId: `${name}-i`, holder: `${name}/i`, role: "full", addr: null, backgroundJobs: true } } as unknown as NodeService;
  const bus = new ClusterBus(shared.bus, node, { register: vi.fn() } as unknown as ClusterJobs);
  bus.onModuleInit();
  const svc = new SearchService(shared.sources, shared.live, bus);
  // MEILI_URL is read when the service starts, so set it then, not when the node is built.
  const start = async () => {
    if (withMeili) process.env.MEILI_URL = `http://meili-${name}`;
    else delete process.env.MEILI_URL;
    await svc.onModuleInit();
  };
  return { bus, svc, name, start, index: () => fake.indexes.get(`http://meili-${name}`) as InstanceType<typeof fake.FakeIndex> | undefined };
}

const idsOf = (n: { index: () => { docs: Map<string, unknown> } | undefined }) => [...(n.index()?.docs.keys() ?? [])].sort();
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00Z"));
  fake.indexes.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

function shared() {
  return { bus: new MemoryBusStore(), sources: new FakeSources(), live: new FakeLive() };
}

describe("search helpers", () => {
  it("hashes content, not key order or the timestamp", () => {
    const a: SearchDoc = { ...doc("ticket", "1", "T"), extra: { a: 1, b: 2 } };
    const b: SearchDoc = { ...doc("ticket", "1", "T"), extra: { b: 2, a: 1 }, updatedAt: "2030-01-01T00:00:00.000Z" };
    expect(docRev(a)).toBe(docRev(b));
    expect(docRev({ ...a, title: "changed" })).not.toBe(docRev(a));
    expect(docRev({ ...a, aclGroupIds: ["g"] })).not.toBe(docRev(a));
  });

  it("diffs: writes new and changed, deletes the missing, leaves the rest", () => {
    const keep = withRev(doc("ticket", "keep", "same"));
    const changed = doc("ticket", "chg", "new title");
    const oldRev = docRev(doc("ticket", "chg", "old title"));
    const existing = new Map<string, string | undefined>([
      [keep.id, keep.rev],
      [changed.id, oldRev],
      [searchDocId("ticket", "gone"), "x"],
      [searchDocId("ticket", "legacy"), undefined], // indexed before revs existed
    ]);
    const { upserts, deletes } = diffDocs(existing, [keep, changed, doc("ticket", "new", "n"), doc("ticket", "legacy", "l")]);
    expect(upserts.map((d) => d.id).sort()).toEqual([changed.id, searchDocId("ticket", "legacy"), searchDocId("ticket", "new")].sort());
    expect(deletes).toEqual([searchDocId("ticket", "gone")]);
  });
});

describe("SearchService across nodes", () => {
  it("brings a new node's empty index up to date from the database at start", async () => {
    const s = shared();
    s.sources.put("ticket", "t1", "Printer jam");
    s.sources.put("ticket", "t2", "Wifi down");
    s.sources.put("note", "n1", "Note");
    s.sources.put("wiki", "w1", "Runbook");
    s.sources.monitoring = [doc("monitor", "m1", "Web")];
    await s.live.replace(["unifi_device"], [doc("unifi_device", "aa:bb", "AP 1")]);

    const a = makeNode("a", s);
    await a.start();
    await advance(10);

    expect(idsOf(a)).toEqual(
      [searchDocId("ticket", "t1"), searchDocId("ticket", "t2"), searchDocId("note", "n1"), searchDocId("wiki", "w1"), searchDocId("monitor", "m1"), searchDocId("unifi_device", "aa:bb")].sort(),
    );
    expect(a.index()!.docs.get(searchDocId("ticket", "t1"))!.rev).toBeTruthy();
  });

  it("applies a change on the writing node at once and on the others within a poll or two", async () => {
    const s = shared();
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await advance(BUS_POLL_MS * 2);

    s.sources.put("ticket", "t9", "New ticket");
    await a.svc.changed("ticket", "t9");
    expect(idsOf(a)).toContain(searchDocId("ticket", "t9")); // read-your-writes on the writer
    expect(idsOf(b)).not.toContain(searchDocId("ticket", "t9")); // not yet on the other

    await advance(BUS_POLL_MS * 2);
    expect(idsOf(b)).toContain(searchDocId("ticket", "t9"));
    expect(b.index()!.docs.get(searchDocId("ticket", "t9"))!.title).toBe("New ticket");
  });

  it("removes a deleted resource's document everywhere", async () => {
    const s = shared();
    s.sources.put("note", "n1", "Soon gone");
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await advance(BUS_POLL_MS * 2);
    expect(idsOf(b)).toContain(searchDocId("note", "n1"));

    s.sources.notes.delete("n1");
    await b.svc.changed("note", "n1");
    await advance(BUS_POLL_MS * 2);
    expect(idsOf(a)).not.toContain(searchDocId("note", "n1"));
    expect(idsOf(b)).not.toContain(searchDocId("note", "n1"));
  });

  it("an edit reaches the other nodes as the current database content, not as a payload", async () => {
    const s = shared();
    s.sources.put("wiki", "w1", "v1");
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await advance(BUS_POLL_MS * 2);

    s.sources.put("wiki", "w1", "v2", { visibility: "group", aclGroupIds: ["g1"] });
    await a.svc.changed("wiki", "w1");
    s.sources.put("wiki", "w1", "v3", { visibility: "group", aclGroupIds: ["g1", "g2"] }); // changes again before b looks
    await advance(BUS_POLL_MS * 2);

    const onB = b.index()!.docs.get(searchDocId("wiki", "w1"))!;
    expect(onB.title).toBe("v3");
    expect(onB.aclGroupIds).toEqual(["g1", "g2"]);
  });

  it("a periodic reconcile fixes drift: stale documents go, missing ones come back, a Meili wipe heals", async () => {
    const s = shared();
    s.sources.put("ticket", "t1", "Real");
    const a = makeNode("a", s);
    await a.start();
    await advance(10);

    a.index()!.docs.set(searchDocId("ticket", "ghost"), withRev(doc("ticket", "ghost", "Not in the database")));
    a.index()!.docs.delete(searchDocId("ticket", "t1"));
    await a.svc.reconcileContent();
    expect(idsOf(a)).toEqual([searchDocId("ticket", "t1")]);
  });

  it("writes nothing when the index already matches", async () => {
    const s = shared();
    s.sources.put("ticket", "t1", "A");
    s.sources.put("note", "n1", "B");
    const a = makeNode("a", s);
    await a.start();
    await advance(10);
    const writesBefore = a.index()!.adds.length;
    const deletesBefore = a.index()!.deletes.length;

    await a.svc.reconcileContent();
    await a.svc.reconcileContent();
    expect(a.index()!.adds.length).toBe(writesBefore);
    expect(a.index()!.deletes.length).toBe(deletesBefore);
  });

  it("rewrites a document indexed before revs existed", async () => {
    const s = shared();
    s.sources.put("ticket", "t1", "Old index");
    const a = makeNode("a", s);
    await a.start();
    await advance(10);
    const id = searchDocId("ticket", "t1");
    const legacy = { ...a.index()!.docs.get(id)! };
    delete legacy.rev;
    a.index()!.docs.set(id, legacy);

    await a.svc.reconcileContent();
    expect(a.index()!.docs.get(id)!.rev).toBeTruthy();
  });

  it("ignores malformed or unknown search notices", async () => {
    const s = shared();
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await advance(BUS_POLL_MS * 2);
    a.bus.publish({ room: "__search", event: "changed", payload: { kind: "bogus", id: "x" } });
    a.bus.publish({ room: "__search", event: "changed", payload: null });
    a.bus.publish({ room: "__search", event: "nonsense" });
    await advance(BUS_POLL_MS * 2);
    expect(idsOf(b)).toEqual([]);
  });

  it("a node with no Meilisearch still tells the others about its writes", async () => {
    const s = shared();
    const a = makeNode("a", s, false);
    await a.start(); // search disabled on this node
    const b = makeNode("b", s);
    await b.start();
    await advance(BUS_POLL_MS * 2);

    s.sources.put("ticket", "t1", "From the node without search");
    await expect(a.svc.changed("ticket", "t1")).resolves.toBeUndefined();
    await advance(BUS_POLL_MS * 2);
    expect(idsOf(b)).toContain(searchDocId("ticket", "t1"));
  });
});

describe("live kinds (UniFi, DNS)", () => {
  const unifiDev = (mac: string, name: string) => ({ mac, name, ip: "10.0.0.2", model: "U6", state: 1, type: "uap" });

  it("one node publishes, every node indexes", async () => {
    const s = shared();
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await advance(BUS_POLL_MS * 2);

    await a.svc.syncUnifi([unifiDev("aa:01", "AP one"), unifiDev("aa:02", "AP two")], [{ mac: "cc:01", name: "Laptop", ip: "10.0.0.50" }]);
    expect(idsOf(a).filter((i) => i.startsWith("unifi_"))).toHaveLength(3);
    await advance(BUS_POLL_MS * 2);
    expect(idsOf(b).filter((i) => i.startsWith("unifi_"))).toHaveLength(3);
  });

  it("an unchanged poll writes nothing and sends no notice", async () => {
    const s = shared();
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await a.svc.syncUnifi([unifiDev("aa:01", "AP one")], []);
    await advance(BUS_POLL_MS * 2);
    const addsB = b.index()!.adds.length;
    const eventsBefore = s.bus.rows.length;

    // The same devices again, but stamped with a later "now": the content is unchanged.
    vi.setSystemTime(new Date("2026-10-04T12:05:00Z"));
    await a.svc.syncUnifi([unifiDev("aa:01", "AP one")], []);
    await advance(BUS_POLL_MS * 2);
    expect(s.bus.rows.length).toBe(eventsBefore);
    expect(b.index()!.adds.length).toBe(addsB);
  });

  it("a device that disappears is removed everywhere; DNS documents are left alone", async () => {
    const s = shared();
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await a.svc.syncDns([{ ...doc("dns_record", "r1", "www.example A") }]);
    await a.svc.syncUnifi([unifiDev("aa:01", "AP one"), unifiDev("aa:02", "AP two")], []);
    await advance(BUS_POLL_MS * 2);

    await a.svc.syncUnifi([unifiDev("aa:01", "AP one")], []);
    await advance(BUS_POLL_MS * 2);
    for (const n of [a, b]) {
      expect(idsOf(n)).toContain(searchDocId("unifi_device", "aa:01"));
      expect(idsOf(n)).not.toContain(searchDocId("unifi_device", "aa:02"));
      expect(idsOf(n)).toContain(searchDocId("dns_record", "r1"));
    }

    await a.svc.syncDns([]); // an unconfigured DNS server clears its kind only
    await advance(BUS_POLL_MS * 2);
    for (const n of [a, b]) {
      expect(idsOf(n)).not.toContain(searchDocId("dns_record", "r1"));
      expect(idsOf(n)).toContain(searchDocId("unifi_device", "aa:01"));
    }
  });

  it("a node that starts later gets the live documents without anything polling the source", async () => {
    const s = shared();
    const a = makeNode("a", s);
    await a.start();
    await a.svc.syncUnifi([unifiDev("aa:01", "AP one")], []);

    const late = makeNode("late", s);
    await late.start();
    await advance(10);
    expect(idsOf(late)).toContain(searchDocId("unifi_device", "aa:01"));
  });
});

describe("reindex", () => {
  it("rebuilds every node's index, and brings the live documents back from their table", async () => {
    const s = shared();
    s.sources.put("ticket", "t1", "Real");
    const a = makeNode("a", s);
    const b = makeNode("b", s);
    await a.start();
    await b.start();
    await a.svc.syncUnifi([{ mac: "aa:01", name: "AP one" }], []);
    await advance(BUS_POLL_MS * 2);

    for (const n of [a, b]) n.index()!.docs.set(searchDocId("ticket", "ghost"), withRev(doc("ticket", "ghost", "Stale")));
    const counts = await a.svc.reindexEverywhere();
    await advance(BUS_POLL_MS * 3);

    expect(counts.tickets).toBe(1);
    for (const n of [a, b]) {
      expect(idsOf(n)).toEqual([searchDocId("ticket", "t1"), searchDocId("unifi_device", "aa:01")].sort());
    }
  });
});
