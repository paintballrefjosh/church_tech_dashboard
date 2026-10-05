import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { acquireLease, releaseLease } from "../src/cluster/lease.store";
import { DbBusStore } from "../src/cluster/bus.store";
import { DbMailOutboxStore } from "../src/mailer/mail-outbox.store";
import { DbLiveSearchStore } from "../src/search/live-search.store";
import type { SearchDoc } from "../src/search/search-types";
import { claimDueMonitors, releaseMonitorClaim } from "../../../services/monitor/src/claim";
import { RateLimitService } from "../src/cluster/rate-limit.service";
import type { ClusterJobs } from "../src/cluster/cluster-jobs.service";

/**
 * Runs the real SQL of the cluster stores against a real database. Skipped
 * unless TEST_DATABASE_URL is set to a database that has had migrations applied
 * (CockroachDB or YugabyteDB). Its tables are emptied first, so never point it
 * at a database you care about.
 *
 *   TEST_DATABASE_URL=postgresql://root@host:26257/scratch?sslmode=disable \
 *     pnpm --filter @church/api exec vitest run test/db-stores.integration.test.ts
 */
const url = process.env.TEST_DATABASE_URL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!url)("cluster stores against a real database", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 20 });
    // The app calls drizzle() once at boot, which replaces pg's timestamp parsers for the whole
    // process (raw strings instead of Dates). Do the same so these tests see what production sees.
    drizzle(pool);
    for (const t of ["cluster_leases", "realtime_events", "realtime_presence", "live_snapshots", "mail_outbox", "rate_limit_buckets", "live_search_docs", "monitors"]) {
      await pool.query(`DELETE FROM ${t}`);
    }
  });
  afterAll(async () => {
    await pool?.end();
  });

  describe("leases", () => {
    it("lets exactly one of many simultaneous acquirers win", async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => acquireLease(pool, "job:race", `node${i}/x`, 30).catch(() => null)),
      );
      expect(results.filter((r) => r !== null)).toHaveLength(1);
    });

    it("renews for the holder, refuses others, and hands over after release or expiry", async () => {
      expect(await acquireLease(pool, "job:a", "A", 30)).toEqual({ epoch: 1 });
      expect(await acquireLease(pool, "job:a", "B", 30)).toBeNull();
      expect(await acquireLease(pool, "job:a", "A", 30)).toEqual({ epoch: 1 });
      await releaseLease(pool, "job:a", "A");
      expect(await acquireLease(pool, "job:a", "B", 1)).toEqual({ epoch: 2 });
      await sleep(1500);
      expect(await acquireLease(pool, "job:a", "C", 30)).toEqual({ epoch: 3 });
    });
  });

  describe("event bus store", () => {
    it("reads the database clock as a real Date", async () => {
      const now = await new DbBusStore(pool).now();
      expect(now).toBeInstanceOf(Date);
      expect(Math.abs(now.getTime() - Date.now())).toBeLessThan(60_000);
    });

    it("round-trips events in order and leaves out the reader's own", async () => {
      const store = new DbBusStore(pool);
      const since = new Date(Date.now() - 1000);
      await store.insert([
        { id: crypto.randomUUID(), originNode: "a/1", seq: 1, room: "user:1", event: "e1", payload: { n: 1 }, ref: null },
        { id: crypto.randomUUID(), originNode: "a/1", seq: 2, room: "user:1", event: "e2", payload: { n: 2 }, ref: null },
        { id: crypto.randomUUID(), originNode: "a/1", seq: 3, room: "network", event: "e3", payload: null, ref: "unifi:network" },
        { id: crypto.randomUUID(), originNode: "b/1", seq: 1, room: "user:1", event: "mine", payload: 1, ref: null },
      ]);
      const rows = await store.fetch(since, "b/1", 100);
      expect(rows.map((r) => r.event)).toEqual(["e1", "e2", "e3"]);
      expect(rows[0]!.payload).toEqual({ n: 1 });
      expect(rows[2]!.payload).toBeNull();
      expect(rows[2]!.ref).toBe("unifi:network");
      expect(rows.every((r) => r.ts instanceof Date)).toBe(true);
    });

    it("tracks presence per node: replace, aggregate, ignore own, clear", async () => {
      const store = new DbBusStore(pool);
      await store.writePresence("n1", new Map([["network", 2], ["infra", 1]]));
      await store.writePresence("n2", new Map([["network", 3]]));
      expect(await store.readPresence("n1", 30)).toEqual(new Map([["network", 3]]));
      expect(await store.readPresence("zzz", 30)).toEqual(new Map([["network", 5], ["infra", 1]]));

      await store.writePresence("n1", new Map([["network", 1]])); // infra dropped
      expect(await store.readPresence("zzz", 30)).toEqual(new Map([["network", 4]]));
      await store.writePresence("n1", new Map());
      await store.writePresence("n2", new Map());
      expect((await store.readPresence("zzz", 30)).size).toBe(0);
    });

    it("treats a node that stopped refreshing as gone", async () => {
      const store = new DbBusStore(pool);
      await store.writePresence("old", new Map([["network", 1]]));
      await pool.query(`UPDATE realtime_presence SET updated_at = now() - interval '5 minutes' WHERE node_id = 'old'`);
      expect((await store.readPresence("me", 20)).size).toBe(0);
      await store.prune(60);
      const left = await pool.query(`SELECT 1 FROM realtime_presence WHERE node_id = 'old'`);
      expect(left.rowCount).toBe(0);
    });

    it("stores one snapshot per kind and overwrites it", async () => {
      const store = new DbBusStore(pool);
      expect(await store.readSnapshot("nothing")).toBeNull();
      await store.writeSnapshot("unifi:network", { devices: [1] });
      await store.writeSnapshot("unifi:network", { devices: [1, 2] });
      expect(await store.readSnapshot("unifi:network")).toEqual({ devices: [1, 2] });
    });

    it("prunes old events", async () => {
      const store = new DbBusStore(pool);
      const id = crypto.randomUUID();
      await store.insert([{ id, originNode: "a/1", seq: 1, room: "r", event: "old", payload: 1, ref: null }]);
      await pool.query(`UPDATE realtime_events SET ts = now() - interval '5 minutes' WHERE id = $1`, [id]);
      await store.prune(60);
      const left = await pool.query(`SELECT 1 FROM realtime_events WHERE id = $1`, [id]);
      expect(left.rowCount).toBe(0);
    });
  });

  describe("mail outbox store", () => {
    it("hands each message to exactly one of several simultaneous claimers", async () => {
      const store = new DbMailOutboxStore(pool);
      await pool.query(`DELETE FROM mail_outbox`);
      for (let i = 0; i < 30; i++) await store.add({ to: `u${i}@x`, subject: "s", text: "t" });

      const claimed: string[] = [];
      const claimer = async () => {
        for (let idle = 0; idle < 3; ) {
          const got = await store.claim(4, 60).catch(() => []); // a collision just comes back empty
          if (got.length === 0) idle++;
          else idle = 0;
          claimed.push(...got.map((g) => g.message.to));
        }
      };
      await Promise.all([claimer(), claimer(), claimer(), claimer()]);

      expect(new Set(claimed).size).toBe(claimed.length); // nobody got a message twice
      // Everything was claimed (collisions only delay a claim, they do not lose it).
      expect(claimed).toHaveLength(30);
    });

    it("counts attempts, retries later, gives up, and prunes failed rows", async () => {
      const store = new DbMailOutboxStore(pool);
      await pool.query(`DELETE FROM mail_outbox`);
      await store.add({ to: "r@x", subject: "s", text: "t", html: "<b>t</b>" });

      const [first] = await store.claim(5, 60);
      expect(first!.attempts).toBe(1);
      expect(first!.message).toEqual({ to: "r@x", subject: "s", text: "t", html: "<b>t</b>" });
      expect(await store.claim(5, 60)).toHaveLength(0); // still claimed

      await store.retryLater(first!.id, 1, "smtp down");
      expect(await store.claim(5, 60)).toHaveLength(0); // not due yet
      await sleep(1300);
      const [second] = await store.claim(5, 60);
      expect(second!.attempts).toBe(2);

      await store.giveUp(second!.id, "still down");
      expect(await store.claim(5, 60)).toHaveLength(0);
      const row = await pool.query(`SELECT status, last_error FROM mail_outbox WHERE id = $1`, [second!.id]);
      expect(row.rows[0]).toEqual({ status: "failed", last_error: "still down" });

      await pool.query(`UPDATE mail_outbox SET updated_at = now() - interval '2 days' WHERE id = $1`, [second!.id]);
      await store.prune(24);
      expect((await pool.query(`SELECT 1 FROM mail_outbox`)).rowCount).toBe(0);
    });

    it("lets another claimer take a message whose claim lapsed", async () => {
      const store = new DbMailOutboxStore(pool);
      await pool.query(`DELETE FROM mail_outbox`);
      await store.add({ to: "lapse@x", subject: "s", text: "t" });
      await store.claim(5, 1); // claimed for one second, then the node dies
      expect(await store.claim(5, 60)).toHaveLength(0);
      await sleep(1500);
      const [again] = await store.claim(5, 60);
      expect(again!.attempts).toBe(2);
    });

    it("sent() removes the message", async () => {
      const store = new DbMailOutboxStore(pool);
      await pool.query(`DELETE FROM mail_outbox`);
      await store.add({ to: "s@x", subject: "s", text: "t" });
      const [m] = await store.claim(5, 60);
      await store.sent(m!.id);
      expect((await pool.query(`SELECT 1 FROM mail_outbox`)).rowCount).toBe(0);
    });
  });

  describe("live search docs store", () => {
    const d = (kind: SearchDoc["kind"], id: string, title: string, over: Partial<SearchDoc> = {}): SearchDoc => ({
      id: `${kind}_${id}`,
      kind,
      resourceId: id,
      title,
      body: "",
      updatedAt: new Date().toISOString(),
      ...over,
    });

    it("writes only what changed and reports whether anything did", async () => {
      const store = new DbLiveSearchStore(pool);
      await pool.query(`DELETE FROM live_search_docs`);
      const set = [d("unifi_device", "a", "AP one"), d("unifi_device", "b", "AP two")];

      expect(await store.replace(["unifi_device"], set)).toBe(true); // first write
      expect(await store.replace(["unifi_device"], set)).toBe(false); // identical
      // Same content, later timestamp: still no change.
      expect(await store.replace(["unifi_device"], set.map((x) => ({ ...x, updatedAt: "2031-01-01T00:00:00.000Z" })))).toBe(false);
      expect(await store.replace(["unifi_device"], [set[0]!, d("unifi_device", "b", "AP two renamed")])).toBe(true); // edited
      expect(await store.replace(["unifi_device"], [set[0]!])).toBe(true); // one removed
      expect((await store.load(["unifi_device"])).map((x) => x.title)).toEqual(["AP one"]);
    });

    it("keeps kinds apart: replacing one does not touch another", async () => {
      const store = new DbLiveSearchStore(pool);
      await pool.query(`DELETE FROM live_search_docs`);
      await store.replace(["dns_record"], [d("dns_record", "r1", "www A")]);
      await store.replace(["unifi_device", "unifi_client"], [d("unifi_device", "a", "AP"), d("unifi_client", "c", "Laptop")]);
      await store.replace(["unifi_device", "unifi_client"], []); // UniFi goes away
      expect((await store.load(["dns_record"])).map((x) => x.id)).toEqual(["dns_record_r1"]);
      expect(await store.load(["unifi_device", "unifi_client"])).toEqual([]);
      await store.replace(["dns_record"], []);
      expect(await store.load(["dns_record"])).toEqual([]);
    });

    it("round-trips a document intact, including extras and a rev", async () => {
      const store = new DbLiveSearchStore(pool);
      await pool.query(`DELETE FROM live_search_docs`);
      await store.replace(["unifi_client"], [d("unifi_client", "c", "Laptop", { extra: { ip: "10.0.0.5", n: [1, 2] }, url: "/monitoring/network" })]);
      const [got] = await store.load(["unifi_client"]);
      expect(got).toMatchObject({ title: "Laptop", extra: { ip: "10.0.0.5", n: [1, 2] }, url: "/monitoring/network" });
      expect(got!.rev).toMatch(/^[0-9a-f]{16}$/);
    });

    it("handles a set much larger than one batch (DNS-sized)", async () => {
      const store = new DbLiveSearchStore(pool);
      await pool.query(`DELETE FROM live_search_docs`);
      const big = Array.from({ length: 1300 }, (_, i) => d("dns_record", `r${i}`, `host${i}.example A`));
      expect(await store.replace(["dns_record"], big)).toBe(true);
      expect(await store.load(["dns_record"])).toHaveLength(1300);
      expect(await store.replace(["dns_record"], big)).toBe(false);
      expect(await store.replace(["dns_record"], big.slice(0, 100))).toBe(true); // 1200 deleted across batches
      expect(await store.load(["dns_record"])).toHaveLength(100);
    });

    it("refuses a document whose kind is not being replaced", async () => {
      const store = new DbLiveSearchStore(pool);
      await expect(store.replace(["dns_record"], [d("unifi_device", "a", "AP")])).rejects.toThrow(/kind/);
    });
  });

  describe("monitor claim", () => {
    const addMonitors = async (n: number, extra = "") => {
      for (let i = 0; i < n; i++) {
        await pool.query(
          `INSERT INTO monitors (name, kind, target, interval_sec, fail_threshold, recover_threshold, options, enabled, status, consecutive_fails, consecutive_oks ${extra ? ", " + extra.split("=")[0] : ""})
           VALUES ($1, 'tcp', 'host:80', 60, 2, 2, '{}'::jsonb, true, 'unknown', 0, 0 ${extra ? ", " + extra.split("=")[1] : ""})`,
          [`m${i}`],
        );
      }
    };
    const all = async () => (await pool.query<{ id: string }>(`SELECT id FROM monitors ORDER BY name`)).rows.map((r) => r.id);

    it("hands each due monitor to exactly one of several simultaneous workers", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(40);
      const claimed: string[] = [];
      const worker = async () => {
        for (let idle = 0; idle < 3; ) {
          const got = await claimDueMonitors(pool, 5, 60).catch(() => []); // a collision just comes back empty
          idle = got.length === 0 ? idle + 1 : 0;
          claimed.push(...got);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      expect(new Set(claimed).size).toBe(claimed.length); // nobody got a monitor twice
      expect(claimed).toHaveLength(40);
    });

    it("does not hand out a monitor that is claimed, disabled, or not yet due", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(1); // due: never checked
      await addMonitors(1); // will be disabled
      await addMonitors(1); // checked just now, 60s interval: not due
      const [a, b, c] = await all();
      await pool.query(`UPDATE monitors SET enabled = false WHERE id = $1`, [b]);
      await pool.query(`UPDATE monitors SET last_checked_at = (now() AT TIME ZONE 'UTC') WHERE id = $1`, [c]);

      expect(await claimDueMonitors(pool, 10, 60)).toEqual([a]);
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([]); // a is held now
    });

    it("hands a monitor back when its check is recorded or its claim is released", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(1);
      const [id] = await all();
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([id]);
      await releaseMonitorClaim(pool, id!);
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([id]);
    });

    it("lets another worker take a monitor whose claim lapsed", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(1);
      const [id] = await all();
      await claimDueMonitors(pool, 10, 1); // a worker takes it for a second, then dies
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([]);
      await sleep(1500);
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([id]);
    });

    it("treats a monitor as due once its interval has passed (UTC wall time, database clock)", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(2);
      const [recent, old] = await all();
      await pool.query(`UPDATE monitors SET last_checked_at = (now() AT TIME ZONE 'UTC') - interval '30 seconds' WHERE id = $1`, [recent]);
      await pool.query(`UPDATE monitors SET last_checked_at = (now() AT TIME ZONE 'UTC') - interval '90 seconds' WHERE id = $1`, [old]);
      expect(await claimDueMonitors(pool, 10, 60)).toEqual([old]); // 90s ago is due at 60s; 30s ago is not
    });

    it("takes the longest-waiting monitors first when there are more due than the batch", async () => {
      await pool.query(`DELETE FROM monitors`);
      await addMonitors(3);
      const ids = await all();
      await pool.query(`UPDATE monitors SET last_checked_at = (now() AT TIME ZONE 'UTC') - interval '10 minutes' WHERE id = $1`, [ids[0]]);
      await pool.query(`UPDATE monitors SET last_checked_at = (now() AT TIME ZONE 'UTC') - interval '5 minutes' WHERE id = $1`, [ids[1]]);
      // ids[2] was never checked, which counts as the longest wait.
      const first = await claimDueMonitors(pool, 2, 60);
      expect(first).toHaveLength(2);
      expect(first).toContain(ids[2]);
      expect(first).toContain(ids[0]);
    });
  });

  describe("shared rate-limit buckets", () => {
    const svc = () => new RateLimitService(pool, { register: vi.fn() } as unknown as ClusterJobs);
    type Hit = { current: number; ttl: number };
    const incr = (store: { incr: (k: string, cb: (e: Error | null, h?: Hit) => void, max: number) => void }, key: string) =>
      new Promise<Hit>((resolve, reject) => store.incr(key, (e, h) => (e ? reject(e) : resolve(h!)), 10));
    const child = (timeWindow: number, url = "/auth/x") => {
      const Store = svc().storeClass();
      const root = new Store({ timeWindow: 60_000 }) as { child: (p: unknown) => never };
      return root.child({ shared: true, timeWindow, routeInfo: { method: "POST", url } });
    };

    it("counts hits one by one and reports time left in the window", async () => {
      const store = child(60_000, "/auth/seq");
      const hits: number[] = [];
      for (let i = 0; i < 5; i++) hits.push((await incr(store, "ip-1")).current);
      expect(hits).toEqual([1, 2, 3, 4, 5]);
      const last = await incr(store, "ip-1");
      expect(last.ttl).toBeGreaterThan(50_000);
      expect(last.ttl).toBeLessThanOrEqual(60_000);
      expect((await incr(store, "ip-2")).current).toBe(1); // another client, own count
    });

    it("counts every one of many simultaneous hits (no hit slips through uncounted)", async () => {
      const store = child(60_000, "/auth/burst");
      const hits = await Promise.all(Array.from({ length: 25 }, () => incr(store, "ip-burst")));
      expect(hits.map((h) => h.current).sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    });

    it("starts a new window once the old one has run out", async () => {
      const store = child(1_000, "/auth/window");
      expect((await incr(store, "ip-w")).current).toBe(1);
      expect((await incr(store, "ip-w")).current).toBe(2);
      await sleep(1300);
      expect((await incr(store, "ip-w")).current).toBe(1);
    });

    it("keeps routes separate", async () => {
      const a = child(60_000, "/auth/route-a");
      const b = child(60_000, "/auth/route-b");
      await incr(a, "ip-r");
      await incr(a, "ip-r");
      expect((await incr(b, "ip-r")).current).toBe(1);
    });
  });
});
