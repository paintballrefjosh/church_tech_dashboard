import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILTIN_TEMPLATES,
  evaluateService,
  parseOutput,
  serviceExprInputs,
  serviceTemplateProblems,
  type CollectorOutcome,
  type ExprValue,
  type PlaceholderValue,
  type Row,
  type ServiceTemplateBody,
} from "@church/shared";
import { respCommand, runCollector, type InstanceRunContext } from "../src/service-monitoring/transports";

/**
 * The second wave of built-in templates (docs/service-monitoring.md section 0) against output captured from the real
 * software in throwaway containers, or written from the vendor's documentation where no server could be run (see
 * fixtures/service-monitoring/README.md), plus the tcp transport's Redis AUTH framing against a fake server.
 */

const FIX = join(__dirname, "fixtures", "service-monitoring");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");
const ok = (rows: Row[]): CollectorOutcome => ({ rows, error: null });

function inputs(t: ServiceTemplateBody, over: Record<string, ExprValue> = {}): Record<string, ExprValue> {
  const out: Record<string, ExprValue> = {};
  for (const i of t.inputs) out[i.key] = (i.default as ExprValue | undefined) ?? "";
  return { ...out, ...over };
}

/** Rows as the collector's own parser makes them. */
function rowsFor(t: ServiceTemplateBody, collector: string, text: string): Row[] {
  const c = t.collect[collector]!;
  if (c.transport === "prometheus") {
    const rows = parseOutput(text, { type: "prometheus" });
    return c.keep ? rows.filter((r) => c.keep!.some((p) => String(r.__name__).startsWith(p))) : rows;
  }
  const spec = "parse" in c ? c.parse : undefined;
  if (!spec) throw new Error(`${collector} has no parser`);
  return parseOutput(text, spec);
}

const breaching = (r: ReturnType<typeof evaluateService>) => r.checks.filter((c) => c.breaching).map((c) => c.id);

const WAVE_TWO = ["redis", "nginx", "rabbitmq", "chrony", "postfix", "mdadm", "zfs", "systemd-failed", "garage", "meilisearch"];

describe("wave two templates", () => {
  it("are all valid built-ins", () => {
    for (const key of WAVE_TWO) {
      const t = BUILTIN_TEMPLATES[key];
      expect(t, key).toBeDefined();
      expect(serviceTemplateProblems(t!), key).toEqual([]);
    }
  });

  it("Redis/Valkey: a master with a replica, a replica whose link is up, and no answer without the password", () => {
    const t = BUILTIN_TEMPLATES.redis!;
    const master = evaluateService(t, { info: ok(rowsFor(t, "info", fixture("valkey-auth-info.txt"))) }, inputs(t), {}, 0);
    expect(master.states).toMatchObject({ role: "master", version: "7.2.4", save_status: "ok" });
    expect(master.values).toMatchObject({ replicas: 1, clients: 1, rejected: null });
    expect(master.values.used_mb).toBeCloseTo(1054384 / 1048576, 3);
    expect(master.values.memory_pct).toBe(null);
    expect(breaching(master)).toEqual([]);

    const replicaRows = rowsFor(t, "info", fixture("valkey-replica-info.txt"));
    const replica = evaluateService(t, { info: ok(replicaRows) }, inputs(t), {}, 0);
    expect(replica.states).toMatchObject({ role: "replica", link: "up" });
    expect(breaching(replica)).toEqual([]);
    // The link going down (as it read while the replica was still syncing) is critical.
    const down = evaluateService(t, { info: ok([{ ...replicaRows[0], master_link_status: "down" }]) }, inputs(t), {}, 0);
    expect(breaching(down)).toEqual(["link_down"]);
    expect(breaching(evaluateService(t, { info: ok(replicaRows) }, inputs(t, { expect_role: "master" }), {}, 0))).toEqual(["wrong_role"]);

    const noauth = evaluateService(t, { info: ok(rowsFor(t, "info", fixture("valkey-noauth.txt"))) }, inputs(t), {}, 0);
    expect(breaching(noauth)).toEqual(["no_info"]);
  });

  it("nginx: connections and requests per second from stub_status", () => {
    const t = BUILTIN_TEMPLATES.nginx!;
    const rows = rowsFor(t, "status", fixture("nginx-stub-status.txt"));
    const first = evaluateService(t, { status: ok(rows) }, inputs(t), {}, 0);
    expect(first.values).toMatchObject({ active: 1, reading: 0, writing: 1, waiting: 0 });
    const later = rows.map((r) => ({ ...r, requests: String(Number(r.requests) + 120), accepts: String(Number(r.accepts) + 13), handled: String(Number(r.handled) + 10) }));
    const second = evaluateService(t, { status: ok(later) }, inputs(t), first.counters, 60_000);
    expect(second.values.requests).toBeCloseTo(2, 5);
    expect(second.values.dropped).toBeCloseTo(0.05, 5);
    expect(breaching(second)).toEqual(["dropped"]);
  });

  it("RabbitMQ: totals, nodes and the fullest queue", () => {
    const t = BUILTIN_TEMPLATES.rabbitmq!;
    const outcomes = {
      overview: ok(rowsFor(t, "overview", fixture("rabbitmq-overview.json"))),
      nodes: ok(rowsFor(t, "nodes", fixture("rabbitmq-nodes.json"))),
      queues: ok(rowsFor(t, "queues", fixture("rabbitmq-queues.json"))),
    };
    const r = evaluateService(t, outcomes, inputs(t), {}, 0);
    expect(r.states.version).toBe("4.0.9");
    expect(r.values).toMatchObject({ ready: 5, unacked: 0, queues: 2, nodes: 1, nodes_down: 0, alarms: 0, fullest_ready: 5 });
    expect(r.members.map((m) => [m.key, m.ok])).toEqual([
      ["jobs", true],
      ["mail", true],
    ]);
    const tight = evaluateService(t, outcomes, inputs(t, { max_ready: 3 }), {}, 0);
    expect(breaching(tight)).toEqual(["backlog"]);
    expect(tight.members.find((m) => m.key === "jobs")?.ok).toBe(false);
    const alarmed = evaluateService(t, { ...outcomes, nodes: ok([{ ...outcomes.nodes.rows![0], disk_free_alarm: true }]) }, inputs(t), {}, 0);
    expect(breaching(alarmed)).toEqual(["alarm"]);
  });

  it("chrony: synchronised, with its offset in milliseconds", () => {
    const t = BUILTIN_TEMPLATES.chrony!;
    const rows = rowsFor(t, "tracking", fixture("chronyc-tracking.csv"));
    const r = evaluateService(t, { tracking: ok(rows) }, inputs(t), {}, 0);
    expect(r.states).toMatchObject({ leap: "Normal", source: "64.131.47.178" });
    expect(r.values.stratum).toBe(2);
    expect(r.values.offset_ms).toBeCloseTo(0.677, 2);
    expect(breaching(r)).toEqual([]);
    const lost = evaluateService(t, { tracking: ok([{ ...rows[0], c14: "Not synchronised", c3: "0" }]) }, inputs(t), {}, 0);
    expect(breaching(lost)).toEqual(["unsynchronised"]);
  });

  it("Postfix: deferred messages from postqueue -j", () => {
    const t = BUILTIN_TEMPLATES.postfix!;
    const rows = rowsFor(t, "queue", fixture("postfix-postqueue.jsonl"));
    const r = evaluateService(t, { queue: ok(rows) }, inputs(t), {}, 0);
    expect(r.values).toMatchObject({ queued: 3, deferred: 3, active: 0, hold: 0 });
    expect(breaching(evaluateService(t, { queue: ok(rows) }, inputs(t, { max_deferred: 2 }), {}, 0))).toEqual(["deferred"]);
    expect(evaluateService(t, { queue: ok([]) }, inputs(t), {}, 0).values.queued).toBe(0);
  });

  it("mdadm: a degraded RAID 5 rebuilding and a healthy mirror", () => {
    const t = BUILTIN_TEMPLATES.mdadm!;
    const rows = rowsFor(t, "arrays", fixture("mdstat.txt"));
    expect(rows.map((x) => [x.array, x.level, x.working, x.total, x.sync ?? null])).toEqual([
      ["md1", "raid5", "2", "3", "recovery"],
      ["md0", "raid1", "2", "2", null],
    ]);
    const r = evaluateService(t, { arrays: ok(rows) }, inputs(t), {}, 0);
    expect(r.values).toMatchObject({ arrays: 2, degraded: 1, syncing: 1 });
    expect(breaching(r)).toEqual(["degraded"]);
    expect(r.members.find((m) => m.key === "md1")).toMatchObject({ ok: false, columns: { "disks working": "2", disks: "3", map: "UU_", rebuilding: "recovery 8.5%" } });
  });

  it("ZFS: a DEGRADED pool and the fullest one", () => {
    const t = BUILTIN_TEMPLATES.zfs!;
    const rows = rowsFor(t, "pools", fixture("zpool-list.tsv"));
    const r = evaluateService(t, { pools: ok(rows) }, inputs(t), {}, 0);
    expect(r.values).toMatchObject({ pools: 2, unhealthy: 1, fullest_pct: 86 });
    expect(breaching(r)).toEqual(["unhealthy", "full"]);
    expect(r.members.find((m) => m.key === "rpool")?.ok).toBe(true);
  });

  it("systemd failed units, with a name left out", () => {
    const t = BUILTIN_TEMPLATES["systemd-failed"]!;
    const rows = rowsFor(t, "failed", fixture("systemctl-failed.txt"));
    const r = evaluateService(t, { failed: ok(rows) }, inputs(t), {}, 0);
    expect(r.values.failed).toBe(1);
    expect(r.members).toEqual([expect.objectContaining({ key: "cd-capture-fail.service", ok: false, columns: { load: "loaded", active: "failed", sub: "failed" } })]);
    expect(evaluateService(t, { failed: ok(rows) }, inputs(t, { ignore: "capture" }), {}, 0).values.failed).toBe(0);
    expect(breaching(evaluateService(t, { failed: ok([]) }, inputs(t), {}, 0))).toEqual([]);
  });

  it("Garage: a healthy single-node cluster from the dev stack", () => {
    const t = BUILTIN_TEMPLATES.garage!;
    const rows = rowsFor(t, "metrics", fixture("garage-metrics.txt"));
    const r = evaluateService(t, { metrics: ok(rows) }, inputs(t), {}, 0);
    expect(r.states.version).toBe("v2.1.0");
    expect(r.values).toMatchObject({ healthy: 1, available: 1, storage_ok: 1, storage_total: 1, partitions_quorum: 256, resync_errors: 0 });
    expect(r.values.free_pct).toBeCloseTo((3953239523328 / 34403459792896) * 100, 3);
    // The dev host's data disk is under 12% free: with the default 10% this passes, with 15% it warns.
    expect(breaching(r)).toEqual([]);
    expect(breaching(evaluateService(t, { metrics: ok(rows) }, inputs(t, { min_free_pct: 15 }), {}, 0))).toEqual(["disk"]);
    const lost = rows.map((x) => (x.__name__ === "cluster_available" || x.__name__ === "cluster_healthy" ? { ...x, value: 0 } : x));
    expect(breaching(evaluateService(t, { metrics: ok(lost) }, inputs(t), {}, 0))).toEqual(["unavailable"]);
  });

  it("Meilisearch: health, documents and tasks from the dev stack", () => {
    const t = BUILTIN_TEMPLATES.meilisearch!;
    const outcomes = {
      health: ok(rowsFor(t, "health", fixture("meilisearch-health.json"))),
      stats: ok(rowsFor(t, "stats", fixture("meilisearch-stats.json"))),
      indexes: ok(rowsFor(t, "indexes", fixture("meilisearch-stats.json"))),
      waiting: ok(rowsFor(t, "waiting", fixture("meilisearch-tasks-waiting.json"))),
      failed: ok(rowsFor(t, "failed", fixture("meilisearch-tasks-failed.json"))),
    };
    const r = evaluateService(t, outcomes, inputs(t), {}, 0);
    expect(r.states.status).toBe("available");
    expect(r.values).toMatchObject({ indexes: 1, documents: 1436, indexing: 0, waiting: 0 });
    expect(r.values.db_mb).toBeCloseTo(424423424 / 1048576, 3);
    expect(r.members).toEqual([expect.objectContaining({ key: "content", columns: { documents: 1436, indexing: "no" } })]);
    expect(breaching(r)).toEqual([]);
    expect(breaching(evaluateService(t, { ...outcomes, health: ok([{ status: "unavailable" }]) }, inputs(t), {}, 0))).toEqual(["unhealthy"]);
  });
});

/** An address of this machine that is not loopback (the transports refuse loopback, as they should). */
function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}

function ctx(host: string, vars: Record<string, string>, secretKeys: string[] = []): InstanceRunContext {
  const v: Record<string, PlaceholderValue> = { host: { value: host, secret: false } };
  for (const [k, x] of Object.entries(vars)) v[k] = { value: x, secret: secretKeys.includes(k) };
  return {
    host,
    ssh: { targetId: "x", host, options: {}, credential: null, knownHostKey: null, prev: null },
    vars: v,
    secrets: secretKeys.map((k) => vars[k]!).filter((s) => s.length >= 4),
  };
}

describe("tcp transport: Redis AUTH", () => {
  it("frames every argument by its length", () => {
    expect(respCommand(["AUTH", "pw"])).toBe("*2\r\n$4\r\nAUTH\r\n$2\r\npw\r\n");
    expect(respCommand(["AUTH", "é"])).toBe("*2\r\n$4\r\nAUTH\r\n$2\r\né\r\n");
  });

  const lan = lanAddress();
  let server: Server;
  let port = 0;
  const received: string[] = [];
  beforeAll(async () => {
    if (!lan) return;
    server = createServer((sock) => {
      let got = "";
      sock.on("data", (d) => {
        got += d.toString("utf8");
        // Answer once the INFO line has arrived, as Redis would: +OK to AUTH, then a bulk string.
        if (got.endsWith("INFO\r\n")) {
          received.push(got);
          const body = "# Server\r\nredis_version:7.2.4\r\nuptime_in_seconds:9\r\nrole:master\r\n";
          sock.end(`+OK\r\n$${body.length}\r\n${body}\r\n`);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, lan, () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it.skipIf(!lan)("sends AUTH as data (a password with a line break in it cannot start another command) and parses the answer", async () => {
    const t = BUILTIN_TEMPLATES.redis!;
    const c = t.collect.info!;
    const r = await runCollector(c, ctx(lan!, { port: String(port), password: "pa ss" }, ["password"]));
    expect(r.error).toBe(null);
    expect(received.at(-1)).toBe("*2\r\n$4\r\nAUTH\r\n$5\r\npa ss\r\nINFO\r\n");
    expect(r.rows).toEqual([{ redis_version: "7.2.4", uptime_in_seconds: "9", role: "master" }]);
    const result = evaluateService(t, { info: { rows: r.rows, error: null } }, serviceExprInputs(t, {}), {}, Date.now());
    expect(result.states.role).toBe("master");

    // A value can hold no line break at all (render refuses it), so nothing typed can add a command.
    const bad = await runCollector(c, ctx(lan!, { port: String(port), password: "x\r\nFLUSHALL" }, ["password"]));
    expect(bad.rows).toBe(null);
    expect(bad.error).toMatch(/line break/);
  });

  it.skipIf(!lan)("a blank password sends no AUTH, and a template's own \\r\\n escapes become CR LF", async () => {
    const r = await runCollector(BUILTIN_TEMPLATES.redis!.collect.info!, ctx(lan!, { port: String(port), password: "" }, ["password"]));
    expect(r.error).toBe(null);
    expect(received.at(-1)).toBe("INFO\r\n");
  });
});

const realRedis = process.env.TEST_SVC_REDIS;
describe.skipIf(!realRedis)("Redis/Valkey template on a real server (TEST_SVC_REDIS=host:port:password)", () => {
  it("reads INFO through AUTH", async () => {
    const [host, port, password] = realRedis!.split(":");
    const t = BUILTIN_TEMPLATES.redis!;
    const r = await runCollector(t.collect.info!, ctx(host!, { port: port!, password: password ?? "" }, ["password"]));
    expect(r.error).toBe(null);
    const result = evaluateService(t, { info: { rows: r.rows, error: null } }, serviceExprInputs(t, {}), {}, Date.now());
    expect(["master", "replica"]).toContain(result.states.role);
    expect(result.values.uptime_s).toBeGreaterThan(0);
  });
});
