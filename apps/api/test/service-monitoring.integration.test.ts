import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { parseDbUrl } from "@church/shared/db";
import * as schema from "../src/db/schema";
import { ServiceMonitoringService } from "../src/service-monitoring/service-monitoring.service";
import { ServicePoller } from "../src/service-monitoring/service-poller";

/**
 * Service monitoring against a real database (docs/service-monitoring.md): an instance is polled by one node at a time, a
 * check that holds for its time opens one incident on the host and its end resolves it, counters become rates, readings
 * are summarised and pruned, secrets are stored encrypted and never returned, a template that runs commands needs them
 * confirmed. The `sql` transport is run for real against the test database itself (CockroachDB and YugabyteDB speak the
 * PostgreSQL protocol), read-only. HAProxy is a local HTTP server answering with captured CSV.
 * Run on CockroachDB and YugabyteDB; it empties the service tables.
 */

const url = process.env.TEST_DATABASE_URL;
const FIX = join(__dirname, "fixtures", "service-monitoring");

/** An address of this machine that is not loopback (the transports refuse loopback, as they should). */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  throw new Error("no non-loopback IPv4 address to serve the fake HAProxy on");
}

describe.skipIf(!url)("service monitoring against a real database", () => {
  let pool: Pool;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const sent: Array<{ kind: string; title: string; link: string }> = [];
  let services: ServiceMonitoringService;
  let make: () => ServicePoller;
  let server: Server;
  let port = 0;
  let csv = readFileSync(join(FIX, "haproxy-stats.csv"), "utf8");
  let requests = 0;
  let hostId: string;
  let dbHostId: string;
  let userId: string;
  const healthy = () =>
    csv
      .split("\n")
      .map((l) => l.replace(/,DOWN,/g, ",UP,"))
      .join("\n");

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= "test-secret-for-service-monitoring-integration";
    pool = new Pool({ connectionString: url, max: 6 });
    const db = drizzle(pool, { schema });
    for (const t of ["service_metric_rollups", "service_metric_samples", "service_instances", "service_logins", "service_templates"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM infra_targets WHERE name LIKE 'svc-test-%'`);
    await q(`DELETE FROM users WHERE email = 'svc-test@test.local'`);
    userId = (await q(`INSERT INTO users (email, name) VALUES ('svc-test@test.local', 'Svc') RETURNING id`)).rows[0].id;

    const lan = lanAddress();
    server = createServer((req, res) => {
      requests++;
      if (req.url !== "/stats;csv") {
        res.writeHead(404).end();
        return;
      }
      // Slow enough that a second node trying at the same moment is still trying while this one reads.
      setTimeout(() => res.writeHead(200, { "content-type": "text/csv" }).end(csv), 300);
    });
    await new Promise<void>((r) => server.listen(0, lan, () => r()));
    port = (server.address() as { port: number }).port;
    hostId = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('svc-test-lb', 'linux_ssh', $1) RETURNING id`, [lan])).rows[0].id;
    const dbHost = parseDbUrl(url!)!.seeds[0]!.host;
    dbHostId = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('svc-test-db', 'linux_ssh', $1) RETURNING id`, [dbHost])).rows[0].id;

    const infra = { getCredential: async () => null, monitoringRecipientIds: async () => [userId] };
    services = new ServiceMonitoringService(db as never, infra as never);
    const jobs = { register: () => undefined };
    const notifications = { createMany: async (rows: typeof sent) => void sent.push(...rows) };
    const activity = { record: async () => undefined };
    const settings = { get: async () => undefined };
    const realtime = { toRoom: () => undefined };
    make = () => new ServicePoller(db as never, jobs as never, services, infra as never, notifications as never, activity as never, settings as never, realtime as never);
  });

  afterAll(async () => {
    await q(`DELETE FROM infra_targets WHERE name LIKE 'svc-test-%'`).catch(() => undefined);
    await q(`DELETE FROM users WHERE email = 'svc-test@test.local'`).catch(() => undefined);
    await pool?.end();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  beforeEach(() => {
    sent.length = 0;
    csv = readFileSync(join(FIX, "haproxy-stats.csv"), "utf8");
  });

  const haproxy = () =>
    services.create(
      { targetId: hostId, templateKey: "haproxy", name: "Load balancer", inputs: { port, path: "/stats;csv" }, secrets: {}, intervalSec: 60, enabled: true },
      userId,
    );

  it("polls an instance once across nodes and records what it read", async () => {
    const inst = await haproxy();
    requests = 0;
    const [a, b] = await Promise.all([make().pollNow(inst.id), make().pollNow(inst.id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(requests).toBe(1);
    const got = await services.get(inst.id);
    expect(got).toMatchObject({ status: "up", lastError: null });
    expect(got.values).toMatchObject({ backends_down: 1, servers_down: 2, sessions: 13 });
    expect(got.members.map((m) => [m.key, m.ok])).toEqual([
      ["dead", false],
      ["app", true],
    ]);
    // Breaching, but not yet for its 60 s: no incident.
    expect(got.checks.find((c) => c.id === "backend_down")).toMatchObject({ breaching: true, open: false });
    expect(Number((await q(`SELECT count(*) AS n FROM service_instances WHERE id = $1 AND claimed_until IS NULL`, [inst.id])).rows[0].n)).toBe(1);
    expect(Number((await q(`SELECT count(*) AS n FROM service_metric_samples WHERE instance_id = $1`, [inst.id])).rows[0].n)).toBe(1);
  });

  it("opens one incident once a check has held for its time, and resolves it when it clears", async () => {
    const inst = await haproxy();
    await make().pollNow(inst.id);
    // As if the backend had been down for two minutes.
    await q(`UPDATE service_instances SET alert_state = jsonb_set(alert_state, '{backend_down,breachingSince}', to_jsonb($2::text)) WHERE id = $1`, [
      inst.id,
      new Date(Date.now() - 120_000).toISOString(),
    ]);
    await make().pollNow(inst.id);
    let got = await services.get(inst.id);
    expect(got.status).toBe("degraded");
    expect(got.checks.find((c) => c.id === "backend_down")?.open).toBe(true);
    const open = await q(`SELECT reason, rule_id FROM monitor_incidents WHERE target_id = $1 AND resolved_at IS NULL`, [hostId]);
    expect(open.rows).toEqual([{ reason: "Load balancer: 1 backend(s) down", rule_id: `svc:${inst.id}:backend_down` }]);
    expect(sent.map((s) => s.kind)).toEqual(["infra.alert.opened"]);
    expect(sent[0]!.link).toBe(`/monitoring/infra/${hostId}/services/${inst.id}`);

    // Polled again while still down: nothing new.
    await make().pollNow(inst.id);
    expect(sent).toHaveLength(1);

    csv = healthy();
    await make().pollNow(inst.id);
    got = await services.get(inst.id);
    expect(got.status).toBe("up");
    expect(Number((await q(`SELECT count(*) AS n FROM monitor_incidents WHERE target_id = $1 AND resolved_at IS NULL`, [hostId])).rows[0].n)).toBe(0);
    expect(sent.map((s) => s.kind)).toEqual(["infra.alert.opened", "infra.alert.resolved"]);
  });

  it("an unreachable service is down with the reason, records no reading, and keeps its last good values", async () => {
    const inst = await haproxy();
    await make().pollNow(inst.id);
    await services.update(inst.id, { inputs: { port, path: "/missing;csv" } });
    await make().pollNow(inst.id);
    const got = await services.get(inst.id);
    expect(got.status).toBe("down");
    expect(got.lastError).toBe("stats: answered 404");
    expect(Number((await q(`SELECT count(*) AS n FROM service_metric_samples WHERE instance_id = $1`, [inst.id])).rows[0].n)).toBe(1);
  });

  it("deleting or switching off an instance resolves what it opened", async () => {
    const inst = await haproxy();
    await make().pollNow(inst.id);
    await q(`UPDATE service_instances SET alert_state = jsonb_set(alert_state, '{backend_down,breachingSince}', to_jsonb($2::text)) WHERE id = $1`, [
      inst.id,
      new Date(Date.now() - 120_000).toISOString(),
    ]);
    await make().pollNow(inst.id);
    await services.update(inst.id, { enabled: false });
    expect(Number((await q(`SELECT count(*) AS n FROM monitor_incidents WHERE rule_id LIKE $1 AND resolved_at IS NULL`, [`svc:${inst.id}:%`])).rows[0].n)).toBe(0);
    expect((await services.get(inst.id)).status).toBe("disabled");
    await services.remove(inst.id);
    await expect(services.get(inst.id)).rejects.toThrow(/No such service/);
  });

  it("summarises readings per metric, and prunes old ones", async () => {
    const inst = await haproxy();
    const t0 = new Date(Math.floor(Date.now() / 300_000) * 300_000 + 1000);
    await q(`INSERT INTO service_metric_samples (instance_id, ts, "values") VALUES ($1, $2, '{"sessions": 10, "servers_down": 2}'), ($1, $3, '{"sessions": 20}')`, [
      inst.id,
      t0,
      new Date(t0.getTime() + 60_000),
    ]);
    await make().rollup();
    const r = await q(`SELECT metric, min, avg, max, samples FROM service_metric_rollups WHERE instance_id = $1 AND bucket = '5m' ORDER BY metric`, [inst.id]);
    expect(r.rows.map((x) => ({ ...x, min: Number(x.min), avg: Number(x.avg), max: Number(x.max), samples: Number(x.samples) }))).toEqual([
      { metric: "servers_down", min: 2, avg: 2, max: 2, samples: 1 },
      { metric: "sessions", min: 10, avg: 15, max: 20, samples: 2 },
    ]);
    // Re-running a bucket that is still filling updates it, never doubles it.
    await make().rollup();
    expect(Number((await q(`SELECT count(*) AS n FROM service_metric_rollups WHERE instance_id = $1 AND bucket = '5m'`, [inst.id])).rows[0].n)).toBe(2);

    const series = await services.series(inst.id, new Date(t0.getTime() - 60_000), new Date(t0.getTime() + 120_000));
    expect(series.resolution).toBe("raw");
    expect(series.points.map((p) => p.values.sessions)).toEqual([10, 20]);

    await q(`INSERT INTO service_metric_samples (instance_id, ts, "values") VALUES ($1, now() - INTERVAL '8 days', '{"sessions": 1}')`, [inst.id]);
    await make().prune();
    expect(Number((await q(`SELECT count(*) AS n FROM service_metric_samples WHERE instance_id = $1 AND ts < now() - INTERVAL '7 days'`, [inst.id])).rows[0].n)).toBe(0);
  });

  it("keeps secrets encrypted and never returns them", async () => {
    const inst = await services.create(
      { targetId: hostId, templateKey: "technitium", name: "DNS", inputs: {}, secrets: { token: "s3cret-token-value" }, intervalSec: 60, enabled: true },
      userId,
    );
    expect(inst.secrets).toEqual({ token: "[saved]" });
    expect(JSON.stringify(inst)).not.toContain("s3cret");
    const stored = (await q(`SELECT secrets_enc FROM service_instances WHERE id = $1`, [inst.id])).rows[0].secrets_enc;
    expect(stored.token).toMatch(/^enc:v1:/);
    // [saved] keeps it, "" removes it (and the template needs one).
    await services.update(inst.id, { secrets: { token: "[saved]" } });
    expect((await q(`SELECT secrets_enc FROM service_instances WHERE id = $1`, [inst.id])).rows[0].secrets_enc.token).toBe(stored.token);
    await expect(services.update(inst.id, { secrets: { token: "" } })).rejects.toThrow(/API token is needed/);
  });

  it("refuses commands nobody confirmed, built-in keys, and deleting what is in use", async () => {
    const body = {
      name: "Custom",
      inputs: [],
      collect: { s: { transport: "ssh", command: "systemctl is-active nginx", parse: { type: "lines" } } },
      metrics: { up: { from: "s", where: "line == 'active'", agg: "count" } },
      checks: [],
    };
    await expect(services.saveTemplate("custom-nginx", body, undefined, userId)).rejects.toThrow(/confirm/);
    await expect(services.saveTemplate("custom-nginx", body, ["s: systemctl is-active apache2"], userId)).rejects.toThrow(/confirm/);
    const t = await services.saveTemplate("custom-nginx", body, ["s: systemctl is-active nginx"], userId);
    expect(t).toMatchObject({ source: "custom", runsCommands: true, version: 1 });
    await expect(services.saveTemplate("haproxy", body, ["s: systemctl is-active nginx"], userId)).rejects.toThrow(/built-in/);
    await expect(
      services.create({ targetId: hostId, templateKey: "custom-nginx", name: "nginx", inputs: {}, secrets: {}, intervalSec: 60, enabled: true }, userId),
    ).rejects.toThrow(/confirm/);
    await services.create(
      { targetId: hostId, templateKey: "custom-nginx", name: "nginx", inputs: {}, secrets: {}, intervalSec: 60, enabled: true, confirmCommands: ["s: systemctl is-active nginx"] },
      userId,
    );
    await expect(services.deleteTemplate("custom-nginx")).rejects.toThrow(/use this template/);
    // A test run runs the commands too: it needs the same confirmation, saved template or text being written.
    await expect(services.test({ targetId: hostId, templateKey: "custom-nginx", inputs: {}, secrets: {} })).rejects.toThrow(/confirm/);
    await expect(services.test({ targetId: hostId, body, inputs: {}, secrets: {} })).rejects.toThrow(/confirm/);
  });

  it("runs a read-only SQL query through a saved login, and a write is refused", async () => {
    const parsed = parseDbUrl(url!)!;
    const [user, password = ""] = parsed.userinfo.replace(/@$/, "").split(":").map(decodeURIComponent);
    const login = await services.createLogin({ name: "svc-test-login", username: user!, password, note: "" });
    const dbName = parsed.rest.replace(/^\//, "").split("?")[0]!;
    const port = Number(parsed.seeds[0]!.port || 5432);
    const inst = await services.create(
      {
        targetId: dbHostId,
        templateKey: "sql-number",
        name: "Templates",
        inputs: { engine: "postgres", port, database: dbName, login: { loginId: login.id }, query: "SELECT count(*) AS n FROM service_templates", above: "0" },
        secrets: {},
        intervalSec: 60,
        enabled: true,
      },
      userId,
    );
    await make().pollNow(inst.id);
    const got = await services.get(inst.id);
    expect(got.lastError).toBe(null);
    expect(got.values.value).toBe(Number((await q(`SELECT count(*) AS n FROM service_templates`)).rows[0].n));

    const test = await services.test({
      targetId: dbHostId,
      templateKey: "sql-number",
      inputs: { engine: "postgres", port, database: dbName, login: { loginId: login.id }, query: "INSERT INTO service_logins (name, username) VALUES ('svc-test-write', 'x')" },
      secrets: {},
    });
    expect(test.down).toBe(true);
    expect(test.collectors[0]!.error).toMatch(/only a query that reads/);
    // A write hidden in a query that starts with WITH: the read-only transaction refuses it on both engines.
    const cte = await services.test({
      targetId: dbHostId,
      templateKey: "sql-number",
      inputs: { engine: "postgres", port, database: dbName, login: { loginId: login.id }, query: "WITH x AS (DELETE FROM service_logins RETURNING 1) SELECT count(*) FROM x" },
      secrets: {},
    });
    expect(cte.collectors[0]!.error).toMatch(/read.only/i);
    expect(Number((await q(`SELECT count(*) AS n FROM service_logins WHERE name = 'svc-test-login'`)).rows[0].n)).toBe(1);
    expect(Number((await q(`SELECT count(*) AS n FROM service_logins WHERE name = 'svc-test-write'`)).rows[0].n)).toBe(0);

    await expect(services.deleteLogin(login.id)).rejects.toThrow(/use this login/);
  });

  it("refuses loopback and the stack's own containers as a service's host", async () => {
    const lo = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('svc-test-lo', 'linux_ssh', '127.0.0.1') RETURNING id`)).rows[0].id;
    const r = await services.test({ targetId: lo, templateKey: "haproxy", inputs: { port }, secrets: {} });
    expect(r.collectors[0]!.error).toMatch(/not an address the dashboard may contact/);
    const api = (await q(`INSERT INTO infra_targets (name, kind, host) VALUES ('svc-test-api', 'linux_ssh', 'api') RETURNING id`)).rows[0].id;
    const r2 = await services.test({ targetId: api, templateKey: "haproxy", inputs: { port }, secrets: {} });
    expect(r2.collectors[0]!.error).toMatch(/is not allowed/);
  });
});
