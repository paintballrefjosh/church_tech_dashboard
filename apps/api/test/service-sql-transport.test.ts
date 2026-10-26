import { describe, expect, it } from "vitest";
import { BUILTIN_TEMPLATES, evaluateService, serviceExprInputs, type CollectorOutcome, type PlaceholderValue, type ServiceTemplateBody } from "@church/shared";
import { runCollector, type InstanceRunContext } from "../src/service-monitoring/transports";

/**
 * The PostgreSQL and MariaDB/MySQL templates against real servers, through the real `sql` transport, with the read-only
 * logins their `needs` text describes. Opt-in: set TEST_SVC_POSTGRES=host:port:user:password and/or
 * TEST_SVC_MYSQL=host:port:user:password (throwaway containers; the address must not be loopback). Run the write tests
 * once with a superuser login (postgres, root) too: they prove nothing is written even when the login could.
 */

function ctxFor(spec: string, extra: Record<string, string> = {}): InstanceRunContext {
  const [host, port, user, password] = spec.split(":");
  const vars: Record<string, PlaceholderValue> = {
    host: { value: host!, secret: false },
    port: { value: port!, secret: false },
    "login.user": { value: user!, secret: false },
    "login.password": { value: password!, secret: true },
    tls: { value: "false", secret: false },
  };
  for (const [k, v] of Object.entries(extra)) vars[k] = { value: v, secret: false };
  return {
    host: host!,
    ssh: { targetId: "x", host: host!, options: {}, credential: null, knownHostKey: null, prev: null },
    vars,
    secrets: [password!],
  };
}

async function runAll(body: ServiceTemplateBody, ctx: InstanceRunContext) {
  const outcomes: Record<string, CollectorOutcome> = {};
  for (const [name, c] of Object.entries(body.collect)) {
    const r = await runCollector(c, ctx);
    outcomes[name] = { rows: r.rows, error: r.error };
  }
  return { outcomes, result: evaluateService(body, outcomes, serviceExprInputs(body, {}), {}, Date.now()) };
}

const pg = process.env.TEST_SVC_POSTGRES;
const my = process.env.TEST_SVC_MYSQL;

describe.skipIf(!pg)("PostgreSQL template on a real server", () => {
  it("reads connections, role and standbys with a pg_monitor login", async () => {
    const t = BUILTIN_TEMPLATES.postgresql!;
    const { outcomes, result } = await runAll(t, ctxFor(pg!, { database: "postgres" }));
    expect(outcomes.stats!.error).toBe(null);
    expect(outcomes.replicas!.error).toBe(null);
    expect(result.down).toBe(false);
    expect(result.values.connections).toBeGreaterThan(0);
    expect(result.values.max_connections).toBe(100);
    expect(result.states.role).toBe("primary");
    expect(result.values.replicas).toBe(0);
  });

  it("never writes: a second statement after a COMMIT, and a data-changing CTE, are refused", async () => {
    const t = BUILTIN_TEMPLATES["sql-number"]!;
    const run = (query: string) => runCollector(t.collect.q!, ctxFor(pg!, { engine: "postgres", database: "postgres", query }));
    expect((await run("SELECT 1; COMMIT; CREATE TABLE should_not_exist (a int)")).error).toMatch(/multiple commands/);
    expect((await run("WITH x AS (DELETE FROM pg_largeobject RETURNING 1) SELECT count(*) FROM x")).error).toMatch(/read-only transaction/);
    expect((await run("CREATE TABLE should_not_exist (a int)")).error).toMatch(/only a query that reads/);
    expect((await run("SELECT to_regclass('should_not_exist') IS NULL AS gone")).rows?.[0]).toMatchObject({ gone: true });
  });

  it("a wrong password is refused, and the password never appears in the error", async () => {
    const [h, p, u] = pg!.split(":");
    const r = await runCollector(BUILTIN_TEMPLATES.postgresql!.collect.stats!, ctxFor(`${h}:${p}:${u}:wrong-password-x`, { database: "postgres" }));
    expect(r.error).toMatch(/password authentication failed/);
    expect(r.error).not.toContain("wrong-password-x");
  });
});

describe.skipIf(!my)("MariaDB template on a real server", () => {
  it("reads status and variables; a server that is no replica is not down", async () => {
    const t = BUILTIN_TEMPLATES.mysql!;
    const { outcomes, result } = await runAll(t, ctxFor(my!));
    expect(outcomes.status!.error).toBe(null);
    expect(outcomes.variables!.error).toBe(null);
    expect(result.down).toBe(false);
    expect(result.values.connections).toBeGreaterThan(0);
    expect(result.values.max_connections).toBeGreaterThan(0);
    expect(result.values.replica_configured).toBe(0);
    expect(result.checks.filter((c) => c.breaching)).toEqual([]);
  });

  it("refuses a write: the query runs in a read-only transaction", async () => {
    const t = BUILTIN_TEMPLATES["sql-number"]!;
    const run = (query: string) => runCollector(t.collect.q!, ctxFor(my!, { engine: "mysql", database: "information_schema", query }));
    expect((await run("CREATE TABLE should_not_exist (a int)")).error).toMatch(/only a query that reads/);
    expect((await run("SELECT 1 INTO OUTFILE '/tmp/should_not_exist'")).error).toMatch(/may not write a file/);
    expect((await run("SELECT 1; CREATE TABLE should_not_exist (a int)")).error).toMatch(/SQL syntax/);
    expect((await run("WITH x AS (SELECT 1) DELETE FROM mysql.help_topic")).error).toMatch(/READ ONLY|syntax|denied/i);
    expect((await run("SELECT count(*) AS n FROM information_schema.tables WHERE table_name = 'should_not_exist'")).rows?.[0]).toMatchObject({ n: "0" });
  });
});
