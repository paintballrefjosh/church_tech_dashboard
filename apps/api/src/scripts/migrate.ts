/* eslint-disable no-console */
import type { Pool, PoolClient } from "pg";
import { createPool, type Queryable } from "@church/shared/db";
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
async function ensureUuidFunction(pool: Queryable, engine: DbEngine): Promise<void> {
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
 * A migration that fails halfway therefore leaves its earlier statements applied. To make a re-run
 * safe (the installer retries, and so does a person), a marker row is written before a migration's
 * first statement and removed once the migration is recorded. A run that finds the marker is RESUMING:
 * a statement that fails because its effect is already there (the object exists, or the thing it drops
 * is gone) is skipped with a note instead of stopping the migration. A migration with no marker gets no
 * such leniency, so a genuine error is never hidden. (A database left half-migrated by an older version,
 * with no marker, is told so and how to start clean.)
 */
const ALREADY_DONE = new Set([
  "42P07", // duplicate table / index
  "42701", // duplicate column
  "42710", // duplicate object (constraint, type, ...)
  "42P06", // duplicate schema
  "42723", // duplicate function
  "42P01", // undefined table (a DROP that already happened)
  "42703", // undefined column
  "42704", // undefined object
]);

async function migrateStepwise(db: Queryable, migrationsFolder: string): Promise<void> {
  await db.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await db.query(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  );
  await db.query(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__church_migration_progress" (hash text PRIMARY KEY NOT NULL, started_at bigint NOT NULL)',
  );
  const last = await db.query<{ created_at: string }>(
    'SELECT created_at FROM "drizzle"."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1',
  );
  const lastMillis = last.rows[0] ? Number(last.rows[0].created_at) : null;
  for (const m of readMigrationFiles({ migrationsFolder })) {
    if (lastMillis !== null && lastMillis >= m.folderMillis) continue;
    const marker = await db.query('SELECT 1 FROM "drizzle"."__church_migration_progress" WHERE hash = $1', [m.hash]);
    const resuming = marker.rows.length > 0;
    if (resuming) {
      console.log(`[migrate] resuming migration ${m.folderMillis}, which an earlier run did not finish: statements already applied are skipped`);
    } else {
      await db.query('INSERT INTO "drizzle"."__church_migration_progress" ("hash", "started_at") VALUES ($1, $2)', [m.hash, Date.now()]);
    }
    let n = 0;
    let skipped = 0;
    for (const stmt of m.sql) {
      // A chunk that is only comments/whitespace is not a statement.
      if (!stmt.replace(/--[^\n]*/g, "").trim()) continue;
      n++;
      try {
        await db.query(stmt);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (resuming && code && ALREADY_DONE.has(code)) {
          skipped++;
          continue;
        }
        console.error(`[migrate] statement ${n} of migration ${m.folderMillis} failed: ${stmt.replace(/\s+/g, " ").slice(0, 300)}`);
        if (!resuming && code && ALREADY_DONE.has(code)) {
          console.error(
            "[migrate] This database already holds part of this migration, from an earlier run that did not finish. " +
              "On a new install the simplest way out is to start the database clean (DROP DATABASE and CREATE DATABASE again) and re-run.",
          );
        }
        throw err;
      }
    }
    if (skipped) console.log(`[migrate] migration ${m.folderMillis}: ${skipped} statement(s) were already applied`);
    await db.query('INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)', [m.hash, m.folderMillis]);
    await db.query('DELETE FROM "drizzle"."__church_migration_progress" WHERE hash = $1', [m.hash]);
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

async function withMigrateLease(pool: Queryable, renewOn: Queryable, fn: () => Promise<void>): Promise<void> {
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
    () => void acquireLease(renewOn, MIGRATE_LEASE, holder, MIGRATE_LEASE_TTL_SEC).catch(() => undefined),
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

  // YugabyteDB applies DDL statement by statement, and a table made a moment ago is visible on another node
  // only after its catalog version has spread. Running every statement on ONE connection (one backend on
  // one node, which always sees its own changes) means the migration never depends on that, whichever of
  // the hosts in DATABASE_URL it landed on. The lease is kept alive from the pool (another connection).
  const ddl: Queryable = engine === "yugabytedb" ? await pool.connect() : pool;
  try {
    await withMigrateLease(ddl, pool, async () => {
      await ensureUuidFunction(ddl, engine);
      if (engine === "yugabytedb") {
        await migrateStepwise(ddl, migrationsFolder);
      } else {
        await migrate(drizzle(pool), { migrationsFolder });
      }
    });
  } finally {
    if (ddl !== pool) (ddl as PoolClient).release();
  }
  await pool.end();
  console.log("[migrate] done");
}

main().catch((err) => {
  // The message first: a long stack trace pasted from the end of a log otherwise hides what actually went wrong.
  console.error(`[migrate] failed: ${(err as { message?: string }).message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
