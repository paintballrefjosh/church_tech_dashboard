import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_TEMPLATES,
  ExprError,
  evalExpr,
  evaluateService,
  hideSecrets,
  jsonPath,
  parseExpr,
  parseOutput,
  renderPlaceholders,
  serviceTemplateProblems,
  shellQuote,
  sqlReadProblem,
  stepCheckAlerts,
  suggestTemplates,
  templateCommands,
  templateRunsCommands,
  type CollectorOutcome,
  type ExprValue,
  type Row,
  type ServiceTemplateBody,
} from "@church/shared";

/**
 * The service monitoring template engine (packages/shared/src/service-monitoring/): the expression language, the parsers,
 * the template checks and every built-in template run against output captured from the real software (see
 * fixtures/service-monitoring/README.md for which files were captured and which were written from documentation).
 */

const FIX = join(__dirname, "fixtures", "service-monitoring");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

const ev = (src: string, vars: Record<string, ExprValue> = {}) => evalExpr(parseExpr(src), (n) => vars[n] ?? null);

/** Default input values of a template, as the poller fills them. */
function defaults(t: ServiceTemplateBody, over: Record<string, ExprValue> = {}): Record<string, ExprValue> {
  const out: Record<string, ExprValue> = {};
  for (const i of t.inputs) out[i.key] = (i.default as ExprValue | undefined) ?? "";
  return { ...out, ...over };
}

const ok = (rows: Row[]): CollectorOutcome => ({ rows, error: null });
const failed = (error: string): CollectorOutcome => ({ rows: null, error });

/** What the prometheus transport does with `keep`. */
function keep(rows: Row[], prefixes: string[] | undefined): Row[] {
  if (!prefixes) return rows;
  return rows.filter((r) => prefixes.some((p) => String(r.__name__).startsWith(p)));
}

describe("expressions", () => {
  it("follows the usual precedence", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("10 - 4 - 3")).toBe(3);
    expect(ev("7 % 4")).toBe(3);
    expect(ev("1 < 2 && 2 < 3 || false")).toBe(true);
    expect(ev("!(1 == 1)")).toBe(false);
    expect(ev("-2 * 3")).toBe(-6);
    expect(ev("a > 1 ? 'big' : 'small'", { a: 5 })).toBe("big");
  });

  it("is null-safe: a missing value never throws", () => {
    expect(ev("missing + 1")).toBe(null);
    expect(ev("missing > 1")).toBe(false);
    expect(ev("missing == null")).toBe(true);
    expect(ev("1 / 0")).toBe(null);
    expect(ev("coalesce(missing, 4)")).toBe(4);
  });

  it("reads names with dots, and backticked names", () => {
    expect(ev("inputs.port + 1", { "inputs.port": 41 })).toBe(42);
    expect(ev("`assigned-addresses` / `total-addresses`", { "assigned-addresses": 1, "total-addresses": 4 })).toBe(0.25);
  });

  it("has the documented functions and only those", () => {
    expect(ev("round(2.345, 2)")).toBe(2.35);
    expect(ev("max(1, 5, 3)")).toBe(5);
    expect(ev("abs(-3)")).toBe(3);
    expect(ev("num('12') + 1")).toBe(13);
    expect(ev("lower('UP') == 'up'")).toBe(true);
    expect(ev("startsWith('DOWN 1/2', 'DOWN')")).toBe(true);
    expect(ev("contains(str(x), 'eth0')", { x: 'device="eth0"' })).toBe(true);
    expect(() => parseExpr("system('ls')")).toThrow(ExprError);
    expect(() => parseExpr("a.constructor()")).toThrow(ExprError);
  });

  it("refuses expressions too long or too deep, and garbage", () => {
    expect(() => parseExpr("1 + ".repeat(300) + "1")).toThrow(ExprError);
    expect(() => parseExpr("(".repeat(60) + "1" + ")".repeat(60))).toThrow(ExprError);
    expect(() => parseExpr("1 +")).toThrow(ExprError);
    expect(() => parseExpr("a = 1")).toThrow(ExprError);
  });
});

describe("parsers", () => {
  it("reads HAProxy's CSV, header comment included", () => {
    const rows = parseOutput(fixture("haproxy-stats.csv"), { type: "csv" });
    const app = rows.find((r) => r.pxname === "app" && r.svname === "BACKEND");
    expect(app?.status).toBe("UP");
    expect(rows.filter((r) => r.svname === "FRONTEND")).toHaveLength(2);
  });

  it("reads Prometheus text, labels, timestamps and the raw label text", () => {
    const rows = parseOutput('# HELP x y\nup{job="a",instance="h:9"} 1 1700000000\nplain 2.5\nnan NaN\n', { type: "prometheus" });
    expect(rows).toEqual([
      { __name__: "up", job: "a", instance: "h:9", _labels: 'job="a",instance="h:9"', value: 1 },
      { __name__: "plain", _labels: "", value: 2.5 },
      { __name__: "nan", _labels: "", value: null },
    ]);
  });

  it("zips Kea's columns and rows", () => {
    const rows = parseOutput(fixture("kea-stat-lease4-get.json"), {
      type: "json",
      rows: "[0].arguments.result-set.rows",
      columns: "[0].arguments.result-set.columns",
    });
    expect(rows[1]).toMatchObject({ "subnet-id": 20, "total-addresses": 4098, "assigned-addresses": 2034 });
  });

  it("expands objects with * and keeps the key", () => {
    const v = JSON.parse(fixture("yugabyte-master-tablet-servers.json"));
    const rows = jsonPath(v, "*.*") as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ _key: "12bb7420c956:9000", status: "ALIVE" });
  });

  it("reads key: value lines, lines and a regex", () => {
    expect(parseOutput("BusyWorkers: 3\nnot a pair\n", { type: "kv", separator: ": " })).toEqual([{ BusyWorkers: "3" }]);
    expect(parseOutput("active\n1\n", { type: "lines" })).toEqual([
      { n: 1, line: "active", f1: "active" },
      { n: 2, line: "1", f1: "1" },
    ]);
    expect(parseOutput("a=1 b=2", { type: "regex", pattern: "(?<k>\\w)=(?<v>\\d)" }).map((r) => r.k)).toEqual(["a", "b"]);
  });

  it("says why when the answer is not what it should be", () => {
    expect(() => parseOutput("<html>", { type: "json" })).toThrow(/not JSON/);
  });
});

describe("placeholders", () => {
  it("shell-quotes every value as one word", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x'; rm -rf / #")).toBe("'x'\\''; rm -rf / #'");
    expect(renderPlaceholders("grep -F -- {{vip}}", { vip: { value: "10.0.0.1; reboot", secret: false } }, "shell")).toBe(
      "grep -F -- '10.0.0.1; reboot'",
    );
  });

  it("refuses line breaks anywhere and unsafe characters in an address", () => {
    expect(() => renderPlaceholders("{{a}}", { a: { value: "x\r\nHost: evil", secret: false } }, "header")).toThrow();
    expect(() => renderPlaceholders("http://{{host}}/", { host: { value: "a b", secret: false } }, "url")).toThrow();
    expect(() => renderPlaceholders("http://{{host}}/", { host: { value: "h/#", secret: false } }, "url")).toThrow();
  });

  it("brackets an IPv6 host", () => {
    expect(renderPlaceholders("http://{{host}}:80/", { host: { value: "fd00::1", secret: false } }, "url")).toBe("http://[fd00::1]:80/");
  });

  it("hides secrets in text", () => {
    expect(hideSecrets("token=abcd1234 failed", ["abcd1234"])).toBe("token=[hidden] failed");
  });
});

describe("template checks", () => {
  it("every built-in template is valid", () => {
    for (const [key, t] of Object.entries(BUILTIN_TEMPLATES)) expect([key, serviceTemplateProblems(t)]).toEqual([key, []]);
  });

  const base = (patch: Partial<ServiceTemplateBody>): ServiceTemplateBody => ({
    name: "t",
    inputs: [
      { key: "token", label: "Token", type: "secret" },
      { key: "login", label: "Login", type: "login" },
      { key: "q", label: "Query", type: "text" },
      { key: "name", label: "Name", type: "string" },
    ],
    collect: { a: { transport: "http", url: "http://{{host}}/", parse: { type: "json" } } },
    metrics: { v: { from: "a", field: "x" } },
    checks: [],
    ...patch,
  });

  it("refuses a secret in an address or a command", () => {
    const inUrl = base({ collect: { a: { transport: "http", url: "http://{{host}}/?t={{token}}", parse: { type: "json" } } } });
    expect(serviceTemplateProblems(inUrl).join()).toMatch(/a secret may only go/);
    const inCmd = base({ collect: { a: { transport: "ssh", command: "curl -u x:{{login.password}} x", parse: { type: "text" } } } });
    expect(serviceTemplateProblems(inCmd).join()).toMatch(/a secret may only go/);
    const inHeader = base({ collect: { a: { transport: "http", url: "http://{{host}}/", headers: { authorization: "Bearer {{token}}" }, parse: { type: "json" } } } });
    expect(serviceTemplateProblems(inHeader)).toEqual([]);
  });

  it("allows a query that is fixed text or one whole text input, nothing in between", () => {
    const sql = (query: string): ServiceTemplateBody =>
      base({ collect: { a: { transport: "sql", engine: "postgres", user: "{{login.user}}", password: "{{login.password}}", query } } });
    expect(serviceTemplateProblems(sql("SELECT 1"))).toEqual([]);
    expect(serviceTemplateProblems(sql("{{q}}"))).toEqual([]);
    expect(serviceTemplateProblems(sql("SELECT * FROM t WHERE n = '{{name}}'")).join()).toMatch(/a query is fixed text/);
  });

  it("accepts only queries that read", () => {
    expect(sqlReadProblem("SELECT 1")).toBe(null);
    expect(sqlReadProblem("  -- a comment\n/* another */ (SELECT 1)")).toBe(null);
    expect(sqlReadProblem("show global status")).toBe(null);
    expect(sqlReadProblem("WITH a AS (SELECT 1) SELECT * FROM a")).toBe(null);
    expect(sqlReadProblem("DROP TABLE x")).toMatch(/not DROP/);
    expect(sqlReadProblem("/* SELECT */ DELETE FROM x")).toMatch(/not DELETE/);
    expect(sqlReadProblem("SELECT * FROM t INTO OUTFILE '/tmp/x'")).toMatch(/write a file/);
    expect(sqlReadProblem("")).toMatch(/an empty one/);
    const t = base({ collect: { a: { transport: "sql", engine: "postgres", user: "{{login.user}}", query: "UPDATE t SET a = 1" } } });
    expect(serviceTemplateProblems(t).join()).toMatch(/only a query that reads/);
  });

  it("checks a sql engine given by an input", () => {
    const withEngine = (engine: string, options: string[]): ServiceTemplateBody =>
      base({
        inputs: [{ key: "engine", label: "E", type: "select", options }, { key: "login", label: "L", type: "login" }],
        collect: { a: { transport: "sql", engine, user: "{{login.user}}", query: "SELECT 1" } },
      });
    expect(serviceTemplateProblems(withEngine("{{engine}}", ["postgres", "mysql"]))).toEqual([]);
    expect(serviceTemplateProblems(withEngine("{{engine}}", ["postgres", "oracle"])).join()).toMatch(/engine/);
    expect(serviceTemplateProblems(withEngine("sqlite", ["postgres"])).join()).toMatch(/engine/);
  });

  it("needs metrics declared before the expressions that read them", () => {
    const t = base({ metrics: { pct: { expr: "v * 100" }, v: { from: "a", field: "x" } } });
    expect(serviceTemplateProblems(t).join()).toMatch(/"v" is not known/);
  });

  it("knows which templates run commands, and lists them", () => {
    expect(templateRunsCommands(BUILTIN_TEMPLATES.keepalived!)).toBe(true);
    expect(templateRunsCommands(BUILTIN_TEMPLATES.haproxy!)).toBe(false);
    expect(templateCommands(BUILTIN_TEMPLATES.keepalived!)[0]).toMatch(/^state: systemctl is-active keepalived/);
  });

  it("suggests templates from a host's units", () => {
    const templates = Object.entries(BUILTIN_TEMPLATES).map(([key, body]) => ({ key, body }));
    const keys = suggestTemplates(templates, [
      { name: "haproxy", active: true },
      { name: "postgresql@16-main", active: true },
      { name: "cron", active: true },
    ]).map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["haproxy", "postgresql"]));
    expect(keys).not.toContain("mysql");
  });
});

describe("built-in templates on real output", () => {
  it("HAProxy: backends and servers down, members with problems first", () => {
    const t = BUILTIN_TEMPLATES.haproxy!;
    const rows = parseOutput(fixture("haproxy-stats.csv"), { type: "csv" });
    const r = evaluateService(t, { stats: ok(rows) }, defaults(t), {}, 1_000);
    expect(r.down).toBe(false);
    expect(r.values.backends_down).toBe(1);
    expect(r.values.servers_down).toBe(2);
    expect(r.values.sessions).toBe(13);
    expect(r.members.map((m) => [m.key, m.ok])).toEqual([
      ["dead", false],
      ["app", true],
    ]);
    expect(r.checks.find((c) => c.id === "backend_down")).toMatchObject({ breaching: true, text: "1 backend(s) down" });
    // First reading of a counter: no rate yet.
    expect(r.values.errors_5xx).toBe(null);
  });

  it("turns a counter into a rate, and a reset into no reading", () => {
    const t = BUILTIN_TEMPLATES.apache!;
    const read = (accesses: number) => [{ BusyWorkers: "1", IdleWorkers: "9", "Total Accesses": String(accesses), "Total kBytes": "0" }];
    const first = evaluateService(t, { status: ok(read(100)) }, defaults(t), {}, 0);
    const second = evaluateService(t, { status: ok(read(160)) }, defaults(t), first.counters, 30_000);
    expect(second.values.requests).toBe(2);
    const reset = evaluateService(t, { status: ok(read(5)) }, defaults(t), second.counters, 60_000);
    expect(reset.values.requests).toBe(null);
    expect(reset.counters.requests).toEqual({ v: 5, t: 60_000 });
  });

  it("Apache: workers from mod_status", () => {
    const t = BUILTIN_TEMPLATES.apache!;
    const rows = parseOutput(fixture("apache-server-status.txt"), { type: "kv", separator: ": " });
    const r = evaluateService(t, { status: ok(rows) }, defaults(t), {}, 0);
    expect(typeof r.values.busy).toBe("number");
    expect(r.values.busy! + r.values.idle!).toBeGreaterThan(0);
    expect(r.values.uptime_s).toBe(4);
  });

  it("CockroachDB: ranges, nodes and disk from /_status/vars", () => {
    const t = BUILTIN_TEMPLATES.cockroachdb!;
    const c = t.collect.vars as { keep?: string[] };
    const rows = keep(parseOutput(fixture("cockroach-status-vars.txt"), { type: "prometheus" }), c.keep);
    const r = evaluateService(t, { vars: ok(rows) }, defaults(t), {}, 0);
    expect(r.values.ranges_unavailable).toBe(0);
    expect(r.values.ranges_underreplicated).toBe(0);
    expect(r.values.live_nodes).toBe(1);
    expect(r.values.sql_conns).toBe(11);
    expect(r.values.disk_used_pct).toBeCloseTo(88.51, 1);
    expect(r.values.clock_offset_ms).toBeCloseTo(0.0246, 4);
    // The dev host's disk really was this full when captured: the check sees it.
    expect(r.checks.find((x) => x.id === "disk")?.breaching).toBe(true);
    expect(r.checks.find((x) => x.id === "unavailable")?.breaching).toBe(false);
  });

  it("YugabyteDB: health, tablet servers and the tablet server's metrics", () => {
    const t = BUILTIN_TEMPLATES.yugabytedb!;
    const health = fixture("yugabyte-master-health.json");
    const servers = fixture("yugabyte-master-tablet-servers.json");
    const tc = t.collect.tserver as { keep?: string[] };
    const r = evaluateService(
      t,
      {
        dead: ok(parseOutput(health, { type: "json", rows: "dead_nodes" })),
        under: ok(parseOutput(health, { type: "json", rows: "under_replicated_tablets" })),
        servers: ok(parseOutput(servers, { type: "json", rows: "*.*" })),
        tserver: ok(keep(parseOutput(fixture("yugabyte-tserver-metrics.txt"), { type: "prometheus" }), tc.keep)),
      },
      defaults(t),
      {},
      0,
    );
    expect(r.values.dead_nodes).toBe(0);
    expect(r.values.under_replicated).toBe(0);
    expect(r.values.tservers_alive).toBe(1);
    expect(r.values.rpc_connections).toBe(16);
    expect(r.members[0]).toMatchObject({ key: "12bb7420c956:9000", ok: true });
    expect(r.checks.every((c) => !c.breaching)).toBe(true);
  });

  it("YugabyteDB: a tablet server metrics page that fails is optional", () => {
    const t = BUILTIN_TEMPLATES.yugabytedb!;
    const health = fixture("yugabyte-master-health.json");
    const r = evaluateService(
      t,
      {
        dead: ok(parseOutput(health, { type: "json", rows: "dead_nodes" })),
        under: ok(parseOutput(health, { type: "json", rows: "under_replicated_tablets" })),
        servers: ok(parseOutput(fixture("yugabyte-master-tablet-servers.json"), { type: "json", rows: "*.*" })),
        tserver: failed("connection refused"),
      },
      defaults(t),
      {},
      0,
    );
    expect(r.down).toBe(false);
    expect(r.errors).toEqual({ tserver: "connection refused" });
    expect(r.values.rpc_connections).toBe(null);
  });

  it("Kea: pool use per subnet", () => {
    const t = BUILTIN_TEMPLATES.kea!;
    const spec = (t.collect.leases as { parse: { type: "json"; rows: string; columns: string } }).parse;
    const r = evaluateService(t, { leases: ok(parseOutput(fixture("kea-stat-lease4-get.json"), spec)) }, defaults(t), {}, 0);
    expect(r.values.subnets).toBe(3);
    expect(r.values.total).toBe(4454);
    expect(r.values.fullest_pct).toBe(95);
    expect(r.members[0]).toMatchObject({ key: "30", ok: false });
    expect(r.checks.find((c) => c.id === "pool_full")).toMatchObject({ breaching: true, text: "A pool is 95% full" });
    expect(r.checks.find((c) => c.id === "declined")?.breaching).toBe(true);
  });

  it("Technitium: last hour's queries and failures", () => {
    const t = BUILTIN_TEMPLATES.technitium!;
    const r = evaluateService(t, { stats: ok(parseOutput(fixture("technitium-dashboard-stats.json"), { type: "json" })) }, defaults(t), {}, 0);
    expect(r.states.status).toBe("ok");
    expect(r.values.queries).toBe(12000);
    expect(r.values.failure_pct).toBeCloseTo(7, 6);
    expect(r.checks.map((c) => [c.id, c.breaching])).toEqual([
      ["api", false],
      ["failures", true],
    ]);
  });

  it("keepalived: role from whether the address is held", () => {
    const t = BUILTIN_TEMPLATES.keepalived!;
    const run = (out: string, role: string) =>
      evaluateService(t, { state: ok(parseOutput(out, { type: "lines" })) }, defaults(t, { vip: "10.0.0.9", expect_role: role }), {}, 0);
    const master = run("active\n1\n", "BACKUP");
    expect(master.states.role).toBe("MASTER");
    expect(master.checks.map((c) => [c.id, c.breaching])).toEqual([
      ["not_running", false],
      ["wrong_role", true],
    ]);
    const stopped = run("inactive\n0\n", "either");
    expect(stopped.states.role).toBe("BACKUP");
    expect(stopped.checks.find((c) => c.id === "not_running")?.breaching).toBe(true);
  });

  it("PostgreSQL: connections and a standby (rows as the sql transport returns them)", () => {
    const t = BUILTIN_TEMPLATES.postgresql!;
    const stats = [{ connections: 90, max_connections: 100, active: 3, long_idle_tx: 0, commits: 10, rollbacks: 0, deadlocks: 0, in_recovery: false, standby_lag_s: null }];
    const replicas = [
      { application_name: "b", client: "10.0.0.2", state: "catchup", replay_lag_s: 120 },
      { application_name: "a", client: "10.0.0.1", state: "streaming", replay_lag_s: 0.2 },
    ];
    const r = evaluateService(t, { stats: ok(stats), replicas: ok(replicas) }, defaults(t), {}, 0);
    expect(r.values.connections_pct).toBe(90);
    expect(r.states.role).toBe("primary");
    expect(r.values.replicas).toBe(2);
    expect(r.members.map((m) => [m.name, m.ok])).toEqual([
      ["b", false],
      ["a", true],
    ]);
    expect(r.checks.filter((c) => c.breaching).map((c) => c.id)).toEqual(["connections", "replica_lag"]);
  });

  it("MariaDB: a server that refuses SHOW REPLICA STATUS is not down", () => {
    const t = BUILTIN_TEMPLATES.mysql!;
    const status = [
      { Variable_name: "Threads_connected", Value: "5" },
      { Variable_name: "Questions", Value: "1000" },
      { Variable_name: "wsrep_local_state_comment", Value: "Donor/Desynced" },
    ];
    const r = evaluateService(
      t,
      { status: ok(status), variables: ok([{ Variable_name: "max_connections", Value: "151" }]), replica: failed("syntax error") },
      defaults(t),
      {},
      0,
    );
    expect(r.down).toBe(false);
    expect(r.values.connections).toBe(5);
    expect(r.checks.filter((c) => c.breaching).map((c) => c.id)).toEqual(["galera"]);
  });

  it("generic Prometheus metric with a label filter", () => {
    const t = BUILTIN_TEMPLATES["prometheus-metric"]!;
    const rows = parseOutput('q{dev="eth0"} 3\nq{dev="eth1"} 4\nother 9\n', { type: "prometheus" });
    const r = evaluateService(t, { metrics: ok(rows) }, defaults(t, { metric: "q", label_filter: "eth1", above: "3" }), {}, 0);
    expect(r.values.value).toBe(4);
    expect(r.values.samples).toBe(2);
    expect(r.checks.find((c) => c.id === "above")?.breaching).toBe(true);
  });

  it("generic JSON value by its path", () => {
    const t = BUILTIN_TEMPLATES["json-value"]!;
    const rows = parseOutput('{"status":{"queue":{"depth":17}}}', { type: "json", rows: "status.queue.depth" });
    const r = evaluateService(t, { data: ok(rows) }, defaults(t, { path: "status.queue.depth", below: "20" }), {}, 0);
    expect(r.values.value).toBe(17);
    expect(r.checks.map((c) => [c.id, c.breaching])).toEqual([
      ["above", false],
      ["below", true],
    ]);
  });
});

describe("check alerts", () => {
  const t: ServiceTemplateBody = {
    name: "t",
    inputs: [],
    collect: { a: { transport: "tcp", port: 1 } },
    metrics: {},
    checks: [{ id: "c", expr: "true", severity: "warning", for: 60, text: "x" }],
  };
  const at = (s: number) => new Date(1_700_000_000_000 + s * 1000);
  const breach = { down: false, checks: [{ id: "c", severity: "warning" as const, breaching: true, text: "x" }] };
  const clear = { down: false, checks: [{ id: "c", severity: "warning" as const, breaching: false, text: "x" }] };

  it("opens only once the breach has held for its time, and resolves on the first clear poll", () => {
    const s1 = stepCheckAlerts(t, breach, {}, at(0));
    expect(s1.transitions).toEqual([]);
    const s2 = stepCheckAlerts(t, breach, s1.state, at(30));
    expect(s2.transitions).toEqual([]);
    const s3 = stepCheckAlerts(t, breach, s2.state, at(61));
    expect(s3.transitions).toEqual([{ id: "c", action: "open" }]);
    const opened = { c: { ...s3.state.c!, open: true, incidentId: "i1" } };
    expect(stepCheckAlerts(t, breach, opened, at(90)).transitions).toEqual([]);
    expect(stepCheckAlerts(t, clear, opened, at(120)).transitions).toEqual([{ id: "c", action: "resolve" }]);
  });

  it("judges nothing while the instance is down, and resolves a check removed from the template", () => {
    const opened = { c: { breachingSince: at(0).toISOString(), open: true, incidentId: "i1" } };
    const down = stepCheckAlerts(t, { down: true, checks: [] }, opened, at(100));
    expect(down.transitions).toEqual([]);
    expect(down.state).toEqual(opened);
    const removed = stepCheckAlerts({ ...t, checks: [] }, { down: false, checks: [] }, opened, at(100));
    expect(removed.transitions).toEqual([{ id: "c", action: "resolve" }]);
  });
});
