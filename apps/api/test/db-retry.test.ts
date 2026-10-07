import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { HostCheckingClient, classifyDbError, createPool, isReadOnlyStatement, shouldRetry, withRetry } from "@church/shared/db";

const err = (code?: string, message = "boom") => Object.assign(new Error(message), code ? { code } : {});

describe("classifyDbError", () => {
  it.each([
    [err("ECONNREFUSED"), "pre-send"],
    [err("ENOTFOUND"), "pre-send"],
    [err("57P03"), "pre-send"],
    [err("53300"), "pre-send"],
    [err(undefined, "timeout exceeded when trying to connect"), "pre-send"],
    [err(undefined, "Connection terminated due to connection timeout"), "pre-send"],
    [err("40001"), "rolled-back"],
    [err("40P01"), "rolled-back"],
    [err("ECONNRESET"), "ambiguous"],
    [err("EPIPE"), "ambiguous"],
    [err("57P01"), "ambiguous"],
    [err("40003"), "ambiguous"],
    [err(undefined, "Connection terminated unexpectedly"), "ambiguous"],
    [err(undefined, "Operation expired: Transaction aborted"), "ambiguous"],
    [err(undefined, "Restart read required at: { read: ... }"), "ambiguous"],
  ])("%s -> %s", (e, expected) => {
    expect(classifyDbError(e)).toBe(expected);
  });

  it.each([
    [err("42601", "syntax error")],
    [err("23505", "duplicate key value violates unique constraint")],
    [err("23503", "foreign key violation")],
    [err("42P01", 'relation "x" does not exist')],
    [new Error("something else")],
    [null],
    ["a string"],
  ])("does not retry %s", (e) => {
    expect(classifyDbError(e)).toBeNull();
  });
});

describe("shouldRetry", () => {
  it("retries a read after an ambiguous failure but not a write", () => {
    expect(shouldRetry(err("ECONNRESET"), "SELECT * FROM users WHERE id = $1")).toBe(true);
    expect(shouldRetry(err("ECONNRESET"), "  select 1")).toBe(true);
    expect(shouldRetry(err("ECONNRESET"), "INSERT INTO tickets (title) VALUES ($1)")).toBe(false);
    expect(shouldRetry(err("ECONNRESET"), "UPDATE users SET name = $1")).toBe(false);
    expect(shouldRetry(err("ECONNRESET"), "DELETE FROM notes WHERE id = $1")).toBe(false);
  });

  it("does not trust a WITH, which can hide a write", () => {
    expect(isReadOnlyStatement("WITH d AS (DELETE FROM notes RETURNING id) SELECT * FROM d")).toBe(false);
    expect(shouldRetry(err("ECONNRESET"), "WITH d AS (DELETE FROM notes RETURNING id) SELECT * FROM d")).toBe(false);
  });

  it("retries anything that certainly did not take effect", () => {
    for (const stmt of ["INSERT INTO t VALUES (1)", "UPDATE t SET a = 1", "DELETE FROM t"]) {
      expect(shouldRetry(err("ECONNREFUSED"), stmt)).toBe(true); // never reached the database
      expect(shouldRetry(err("40001"), stmt)).toBe(true); // the database rolled it back
    }
  });

  it("never retries an error that retrying cannot fix", () => {
    expect(shouldRetry(err("23505"), "SELECT 1")).toBe(false);
    expect(shouldRetry(err("42601"), "SELECT 1")).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns the result once an attempt succeeds, with growing waits", async () => {
    const waits: number[] = [];
    let n = 0;
    const out = await withRetry(
      async () => {
        if (++n < 4) throw err("ECONNREFUSED");
        return "ok";
      },
      () => true,
      { attempts: 5, baseMs: 100, maxMs: 1_000, sleep: async (ms) => void waits.push(ms) },
    );
    expect(out).toBe("ok");
    expect(n).toBe(4);
    expect(waits).toHaveLength(3);
    // 100, 200, 400 ms nominal, each jittered down to between half and full.
    expect(waits[0]!).toBeGreaterThanOrEqual(50);
    expect(waits[0]!).toBeLessThanOrEqual(100);
    expect(waits[2]!).toBeGreaterThanOrEqual(200);
    expect(waits[2]!).toBeLessThanOrEqual(400);
  });

  it("gives up after the last attempt and throws the last error", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw err("ECONNREFUSED", `attempt ${n}`);
        },
        () => true,
        { attempts: 3, sleep: async () => undefined },
      ),
    ).rejects.toThrow("attempt 3");
    expect(n).toBe(3);
  });

  it("throws at once for an error it should not retry", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw err("23505");
        },
        (e) => classifyDbError(e) !== null,
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("caps a single wait", async () => {
    const waits: number[] = [];
    await expect(
      withRetry(async () => Promise.reject(err("ECONNREFUSED")), () => true, {
        attempts: 8,
        baseMs: 1_000,
        maxMs: 2_000,
        sleep: async (ms) => void waits.push(ms),
      }),
    ).rejects.toThrow();
    expect(Math.max(...waits)).toBeLessThanOrEqual(2_000);
  });
});

describe("createPool", () => {
  const spy = () => vi.spyOn(Pool.prototype, "query") as unknown as ReturnType<typeof vi.fn>;
  const quiet = () => undefined;
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("handles an idle-connection error instead of letting it crash the process", async () => {
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
    expect(pool.listenerCount("error")).toBeGreaterThan(0);
    // With no listener this would throw; with one it is just reported.
    expect(() => pool.emit("error", new Error("terminating connection due to administrator command"))).not.toThrow();
    await pool.end();
  });

  it("always uses the public schema, whatever the login or its schemas are called", async () => {
    const pool = createPool({ name: "t", url: "postgresql://church_tech@localhost:1/db", log: quiet });
    expect((pool as unknown as { options: Record<string, unknown> }).options.options).toBe("-c search_path=public");
    await pool.end();
  });

  it("leaves options the URL sets itself alone", async () => {
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db?options=-c%20search_path%3Dmine", log: quiet });
    const o = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(o.options === undefined || !String(o.options).includes("search_path=public")).toBe(true);
    await pool.end();
  });

  it("names its connections and sets timeouts, keep-alive and a connection lifetime", async () => {
    const pool = createPool({ name: "monitor", url: "postgresql://x@localhost:1/db", log: quiet });
    const o = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(o.application_name).toBe("church-monitor");
    expect(o.connectionTimeoutMillis).toBeGreaterThan(0);
    expect(o.keepAlive).toBe(true);
    expect(o.maxLifetimeSeconds).toBeGreaterThan(0);
    await pool.end();
  });

  it("retries a SELECT whose connection broke, then returns the result", async () => {
    let calls = 0;
    spy().mockImplementation(async () => {
      if (++calls < 3) throw err("ECONNRESET");
      return { rows: [{ x: 1 }] };
    });
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
    const p = pool.query("SELECT 1 AS x");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(p).resolves.toEqual({ rows: [{ x: 1 }] });
    expect(calls).toBe(3);
    await pool.end();
  });

  it("does not retry a write whose outcome is unknown", async () => {
    let calls = 0;
    spy().mockImplementation(async () => {
      calls++;
      throw err("ECONNRESET");
    });
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
    const p = pool.query("INSERT INTO t VALUES (1)");
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(calls).toBe(1);
    await pool.end();
  });

  it("retries a write that never reached the database, and one the database rolled back", async () => {
    for (const code of ["ECONNREFUSED", "40001"]) {
      let calls = 0;
      spy().mockReset();
      spy().mockImplementation(async () => {
        if (++calls < 2) throw err(code);
        return { rows: [] };
      });
      const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
      const p = pool.query({ text: "UPDATE t SET a = $1", values: [1] });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(p).resolves.toEqual({ rows: [] });
      expect(calls).toBe(2);
      await pool.end();
    }
  });

  it("gives up after the configured number of attempts", async () => {
    let calls = 0;
    spy().mockImplementation(async () => {
      calls++;
      throw err("ECONNREFUSED");
    });
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", retryAttempts: 3, log: quiet });
    const p = pool.query("SELECT 1");
    const assertion = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(calls).toBe(3);
    await pool.end();
  });

  it("does not retry an ordinary SQL error", async () => {
    let calls = 0;
    spy().mockImplementation(async () => {
      calls++;
      throw err("42601", "syntax error");
    });
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
    await expect(pool.query("SELEC 1")).rejects.toThrow("syntax error");
    expect(calls).toBe(1);
    await pool.end();
  });

  it("leaves callback-style calls alone", async () => {
    const q = spy();
    q.mockImplementation(() => undefined);
    const pool = createPool({ name: "t", url: "postgresql://x@localhost:1/db", log: quiet });
    const cb = () => undefined;
    (pool.query as unknown as (...a: unknown[]) => unknown)("SELECT 1", cb);
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0]!.at(-1)).toBe(cb);
    await pool.end();
  });
});

describe("HostCheckingClient", () => {
  const checker = (config: Record<string, unknown>) =>
    (new HostCheckingClient(config as never) as unknown as { connectionParameters: { ssl: { checkServerIdentity?: unknown } } }).connectionParameters.ssl;

  it("makes TLS to an IP address check the certificate against that IP", () => {
    expect(typeof checker({ host: "10.0.0.5", ssl: { ca: "x" } }).checkServerIdentity).toBe("function");
    expect(typeof checker({ host: "2001:db8::1", ssl: { ca: "x" } }).checkServerIdentity).toBe("function");
  });

  it("leaves a host name alone (pg already verifies those)", () => {
    expect(checker({ host: "db.example.org", ssl: { ca: "x" } }).checkServerIdentity).toBeUndefined();
  });

  it("respects an operator who chose not to verify, or who set their own check", () => {
    expect(checker({ host: "10.0.0.5", ssl: { ca: "x", rejectUnauthorized: false } }).checkServerIdentity).toBeUndefined();
    const own = () => undefined;
    expect(checker({ host: "10.0.0.5", ssl: { ca: "x", checkServerIdentity: own } }).checkServerIdentity).toBe(own);
  });

  it("does nothing when TLS is off", () => {
    const c = new HostCheckingClient({ host: "10.0.0.5" } as never) as unknown as { connectionParameters: { ssl: unknown } };
    expect(c.connectionParameters.ssl).toBeFalsy();
  });
});
