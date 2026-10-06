import { describe, expect, it } from "vitest";
import { createPool, parseDbUrl, dbUrlWithSeed } from "@church/shared/db";

/**
 * A URL whose first hosts are dead still reaches the database. Skipped unless TEST_DATABASE_URL is
 * set (any CockroachDB or YugabyteDB, or PostgreSQL).
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("several hosts in DATABASE_URL against a real database", () => {
  const withDeadHosts = (): string => {
    const p = parseDbUrl(url!)!;
    return dbUrlWithSeed({ ...p, seeds: [{ host: "127.0.0.1", port: "1" }, { host: "127.0.0.1", port: "2" }, ...p.seeds] }, p.seeds[0]!)
      .replace(/@[^/?#]+/, `@127.0.0.1:1,127.0.0.1:2,${p.seeds.map((s) => s.host + (s.port ? ":" + s.port : "")).join(",")}`);
  };

  it("answers although the first two hosts refuse connections", async () => {
    const pool = createPool({ name: "multihost-test", url: withDeadHosts(), max: 4 });
    try {
      const res = await Promise.all(Array.from({ length: 8 }, () => pool.query("SELECT 1 AS one")));
      expect(res.every((r) => Number(r.rows[0].one) === 1)).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it("opens a transaction through pool.connect with dead hosts first", async () => {
    const pool = createPool({ name: "multihost-test", url: withDeadHosts(), max: 2 });
    try {
      const client = await pool.connect();
      await client.query("BEGIN");
      const r = await client.query("SELECT 2 AS two");
      await client.query("COMMIT");
      client.release();
      expect(Number(r.rows[0].two)).toBe(2);
    } finally {
      await pool.end();
    }
  });
});
