import { afterEach, describe, expect, it } from "vitest";
import { HostSet, createPool, dbUrlWithSeed, parseDbUrl } from "@church/shared/db";

describe("parseDbUrl", () => {
  it("reads one host", () => {
    const p = parseDbUrl("postgresql://u:pw@db.example.org:5433/church?sslmode=require")!;
    expect(p.seeds).toEqual([{ host: "db.example.org", port: "5433" }]);
    expect(p.userinfo).toBe("u:pw@");
    expect(p.rest).toBe("/church?sslmode=require");
  });

  it("reads a host list, with or without ports, and an IPv6 host", () => {
    const p = parseDbUrl("postgres://u:pw@a:5433,b:5433,10.0.0.3,[::1]:5433/church")!;
    expect(p.seeds.map((s) => `${s.host}|${s.port}`)).toEqual(["a|5433", "b|5433", "10.0.0.3|", "[::1]|5433"]);
  });

  it("rebuilds the URL with one host, keeping everything else", () => {
    const p = parseDbUrl("postgresql://u:p%40ss@a:5433,b:5434/church?sslmode=disable&application_name=x")!;
    expect(dbUrlWithSeed(p, p.seeds[1]!)).toBe("postgresql://u:p%40ss@b:5434/church?sslmode=disable&application_name=x");
  });

  it("works with no user and no database", () => {
    const p = parseDbUrl("postgresql://a:1,b:2")!;
    expect(dbUrlWithSeed(p, p.seeds[0]!)).toBe("postgresql://a:1");
  });

  it("returns null for something that is not a postgres URL", () => {
    expect(parseDbUrl("mysql://a/b")).toBeNull();
    expect(parseDbUrl("not a url")).toBeNull();
  });
});

describe("HostSet", () => {
  const three = () => parseDbUrl("postgresql://u@a:1,b:1,c:1/db")!;
  const make = (now: () => number = () => 0) => new HostSet(three(), () => undefined, now, () => 0);

  it("sends new connections to the host with the fewest open", () => {
    const set = make();
    const [a, b, c] = three().seeds as [never, never, never];
    set.opening(a); set.opening(a); set.opening(b);
    expect(set.pick()).toEqual(c);
    set.opening(c); set.opening(c);
    expect(set.pick()).toEqual(b);
  });

  it("counts a connection out again when it closes", () => {
    const set = make();
    const [a, b] = three().seeds as [never, never];
    set.opening(a); set.opening(b); set.opening(b);
    expect(set.pick()).toEqual(three().seeds[2]);
    set.closed(b); set.closed(b);
    set.opening(three().seeds[2]!);
    expect(set.pick()).toEqual(b);
  });

  it("breaks ties with the random source", () => {
    const set = new HostSet(three(), () => undefined, () => 0, () => 0.99);
    expect(set.pick()).toEqual(three().seeds[2]);
  });

  it("leaves a failed host out for a cooldown, then lets it back", () => {
    let t = 1_000;
    const set = make(() => t);
    const [a, b, c] = three().seeds as [never, never, never];
    set.failed(a);
    for (let i = 0; i < 6; i++) { const p = set.pick(); expect(p).not.toEqual(a); set.opening(p); }
    t += 5_001;
    // a has no connections, the others have three each: it is picked first
    expect(set.pick()).toEqual(a);
    void b; void c;
  });

  it("doubles the cooldown on each failure in a row, up to a minute, and forgets it on success", () => {
    let t = 0;
    const set = make(() => t);
    const a = three().seeds[0]!;
    const available = () => set.pick().host === "a";
    set.failed(a);                                  // 5 s
    t = 4_999; expect(available()).toBe(false);
    t = 5_000; expect(available()).toBe(true);
    set.failed(a);                                  // 10 s more, from t=5000
    t = 14_999; expect(available()).toBe(false);
    t = 15_000; expect(available()).toBe(true);
    for (let i = 0; i < 8; i++) set.failed(a);      // capped at 60 s
    const base = t;
    t = base + 59_999; expect(available()).toBe(false);
    t = base + 60_000; expect(available()).toBe(true);
    set.failed(a); set.succeeded(a);                // a success clears it
    expect(available()).toBe(true);
  });

  it("tries the host that comes back soonest when every host is down", () => {
    let t = 0;
    const set = make(() => t);
    const [a, b, c] = three().seeds as [never, never, never];
    set.failed(b); t = 10; set.failed(a); t = 20; set.failed(c);
    expect(set.pick()).toEqual(b);
  });
});

describe("createPool with several hosts", () => {
  const pools: Array<{ end: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end().catch(() => undefined)));
  });

  it("tries each host in turn when none answers, and says which failed", async () => {
    const logs: string[] = [];
    const pool = createPool({
      name: "t",
      url: "postgresql://x@127.0.0.1:1,127.0.0.1:2,127.0.0.1:3/db",
      log: (m) => logs.push(m),
      retryAttempts: 4,
    });
    pools.push(pool);
    await expect(pool.query("SELECT 1")).rejects.toThrow();
    const mentioned = new Set(logs.filter((l) => l.includes("could not connect to")).map((l) => l.match(/connect to ([^;]+);/)?.[1]));
    // every attempt after the first went to a host that had not yet failed
    expect(mentioned.size).toBeGreaterThanOrEqual(3);
  });

  it("still retries a checked-out connection (pool.connect) on the next host", async () => {
    const logs: string[] = [];
    const pool = createPool({
      name: "t",
      url: "postgresql://x@127.0.0.1:1,127.0.0.1:2/db",
      log: (m) => logs.push(m),
      retryAttempts: 3,
    });
    pools.push(pool);
    await expect(pool.connect()).rejects.toThrow();
    expect(logs.filter((l) => l.includes("could not connect to")).length).toBe(2);
  });

  it("leaves a one-host URL exactly as before", async () => {
    const pool = createPool({ name: "t", url: "postgresql://x@127.0.0.1:1/db", log: () => undefined });
    pools.push(pool);
    const o = (pool as unknown as { options: { Client: { name: string } } }).options;
    expect(o.Client.name).toBe("HostCheckingClient");
  });
});
