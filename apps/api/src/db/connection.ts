import type { Pool } from "pg";

/**
 * Database connection settings, shared by the API, its scripts (migrate, seed,
 * user resets) and drizzle-kit.
 *
 * The app speaks the Postgres wire protocol and runs on CockroachDB (bundled
 * single node, or external) or YugabyteDB YSQL (external). Which one is
 * detected at runtime from `SELECT version()`; deployments only say *where*
 * the database is (`DATABASE_URL`), never which engine it is.
 *
 * `COCKROACH_URL` is the pre-Yugabyte name, still accepted so existing .env
 * files keep working.
 */
export function databaseUrl(): string {
  const url = process.env.DATABASE_URL || process.env.COCKROACH_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
}

export type DbEngine = "cockroachdb" | "yugabytedb" | "postgresql";

/**
 * CockroachDB reports "CockroachDB CCL v24.2.0 …"; YugabyteDB reports
 * "PostgreSQL 15.12-YB-2026.1.2.0-b0 …" (the -YB- suffix); anything else is
 * treated as plain PostgreSQL.
 */
export function engineFromVersion(version: string): DbEngine {
  if (/cockroachdb/i.test(version)) return "cockroachdb";
  if (/-YB-/.test(version)) return "yugabytedb";
  return "postgresql";
}

export async function detectEngine(pool: Pool): Promise<{ engine: DbEngine; version: string }> {
  const res = await pool.query<{ version: string }>("SELECT version() AS version");
  const version = res.rows[0]?.version ?? "";
  return { engine: engineFromVersion(version), version };
}

/** Short human label for health pages: "YugabyteDB 2026.1.2.0", "CockroachDB v24.2.0". */
export function engineLabel(engine: DbEngine, version: string): string {
  if (engine === "cockroachdb") {
    const m = /CockroachDB \S+ (v[\d.]+)/i.exec(version);
    return `CockroachDB ${m?.[1] ?? ""}`.trim();
  }
  if (engine === "yugabytedb") {
    const m = /-YB-([\d.]+)/.exec(version);
    return `YugabyteDB ${m?.[1] ?? ""}`.trim();
  }
  const m = /PostgreSQL ([\d.]+)/.exec(version);
  return `PostgreSQL ${m?.[1] ?? ""}`.trim();
}
