/* eslint-disable no-console */
import type { Pool } from "pg";
import { createPool } from "@church/shared/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseUrl, detectEngine, engineLabel, type DbEngine } from "../db/connection";
import { acquireLease, releaseLease } from "../cluster/lease.store";

/**
 * Migrations are plain SQL that must run unchanged on every supported engine
 * (CockroachDB, YugabyteDB YSQL). The one engine-specific prerequisite is
 * handled here: `gen_random_uuid()` (used by every uuid primary key) is built
 * in on CockroachDB and on Postgres 13+ bases, but lives in the `pgcrypto`
 * extension on older ones (YugabyteDB 2024.2 LTS is PG 11 based).
 */
async function ensureUuidFunction(pool: Pool, engine: DbEngine): Promise<void> {
  if (engine === "cockroachdb") return;
  const res = await pool.query<{ fn: string | null }>("SELECT to_regproc('gen_random_uuid')::text AS fn");
  if (res.rows[0]?.fn) return;
  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    console.log("[migrate] enabled pgcrypto for gen_random_uuid()");
  } catch (err) {
    throw new Error(
      `gen_random_uuid() is missing and enabling pgcrypto failed (${(err as Error).message}). ` +
        "Ask the database owner to run: CREATE EXTENSION IF NOT EXISTS pgcrypto;",
    );
  }
}

/**
 * drizzle's migrator applies every pending migration inside ONE transaction.
 * CockroachDB and Postgres handle that, but YugabyteDB doesn't support DDL in
 * a transaction block by default: each DDL bumps the catalog version and the
 * long-running transaction gets aborted ("expired or aborted by a conflict").
 * So on YugabyteDB, apply each migration's statements one by one (autocommit)
 * and record it in drizzle's own journal table, with drizzle's rules, so the
 * two paths stay interchangeable.
 *
 * Trade-off: a migration that fails halfway on YugabyteDB leaves its earlier
 * statements applied and is not recorded. Migrations here use IF NOT EXISTS
 * where drizzle-kit allows it; anything else needs a manual fix before re-running.
 */
async function migrateStepwise(pool: Pool, migrationsFolder: string): Promise<void> {
  await pool.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await pool.query(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  );
  const last = await pool.query<{ created_at: string }>(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  const lastMillis = last.rows[0] ? Number(last.rows[0].created_at) : null;
  for (const m of readMigrationFiles({ migrationsFolder })) {
    if (lastMillis !== null && lastMillis >= m.folderMillis) continue;
    for (const stmt of m.sql) {
      // A chunk that is only comments/whitespace is not a statement.
      if (!stmt.replace(/--[^\n]*/g, "").trim()) continue;
      await pool.query(stmt);
    }
    await pool.query('INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)', [
      m.hash,
      m.folderMillis,
    ]);
  }
}

/**
 * Two nodes running migrations at once would race on DDL and on drizzle's
 * journal, so the whole run holds the `migrate` lease (docs/multi-node.md). A
 * second runner waits for the first to finish, then finds nothing left to apply.
 *
 * `cluster_leases` is created by migration 0050, so on a database that has not
 * seen it yet the table is created here first, with the same definition and
 * `IF NOT EXISTS` so 0050 is then a no-op.
 */
const MIGRATE_LEASE = "migrate";
const MIGRATE_LEASE_TTL_SEC = 300;
const MIGRATE_LEASE_WAIT_MS = 10 * 60_000;

async function withMigrateLease(pool: Pool, fn: () => Promise<void>): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "cluster_leases" (
       "name" text PRIMARY KEY NOT NULL,
       "holder" text NOT NULL,
       "epoch" integer DEFAULT 1 NOT NULL,
       "expires_at" timestamp with time zone NOT NULL
     )`,
  );
  const holder = `migrate/${randomUUID().slice(0, 8)}`;
  const deadline = Date.now() + MIGRATE_LEASE_WAIT_MS;
  let announced = false;
  while (!(await acquireLease(pool, MIGRATE_LEASE, holder, MIGRATE_LEASE_TTL_SEC))) {
    if (Date.now() > deadline) throw new Error("another node has held the migrate lease for over 10 minutes");
    if (!announced) console.log("[migrate] another node is migrating; waiting for it to finish");
    announced = true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  // Keep the lease alive while a long migration runs.
  const renew = setInterval(
    () => void acquireLease(pool, MIGRATE_LEASE, holder, MIGRATE_LEASE_TTL_SEC).catch(() => undefined),
    (MIGRATE_LEASE_TTL_SEC * 1000) / 3,
  );
  try {
    await fn();
  } finally {
    clearInterval(renew);
    await releaseLease(pool, MIGRATE_LEASE, holder).catch(() => undefined);
  }
}

async function main() {
  const migrationsFolder = path.resolve(__dirname, "../../migrations");
  const pool = createPool({ name: "migrate", url: databaseUrl(), max: 4, queryTimeoutMs: 0 });
  const { engine, version } = await detectEngine(pool);
  console.log(`[migrate] ${engineLabel(engine, version)}; applying migrations from ${migrationsFolder}`);

  await withMigrateLease(pool, async () => {
    await ensureUuidFunction(pool, engine);
    if (engine === "yugabytedb") {
      await migrateStepwise(pool, migrationsFolder);
    } else {
      await migrate(drizzle(pool), { migrationsFolder });
    }
  });
  await pool.end();
  console.log("[migrate] done");
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
