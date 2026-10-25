import type { Pool } from "pg";
import { createPool, databaseUrlFromEnv } from "@church/shared/db";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./db-schema";

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  // Error handler, timeouts, retry of safe statements and TLS from the URL all
  // come from the shared factory (a dying database node must not crash Next).
  _pool = createPool({ name: "web", url: databaseUrlFromEnv(), max: 5 });
  return _pool;
}

/**
 * Lazily-initialised drizzle client. Wrapping in a Proxy means importing this
 * module does not connect to or even read DATABASE_URL at build time — only
 * when a query actually runs.
 */
function real(): NodePgDatabase<typeof schema> {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}

export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(real() as object, prop, receiver);
  },
  // drizzle's `is()` (the Auth.js adapter asks `is(db, PgDatabase)`) walks the prototype chain since drizzle 0.45, so the
  // proxy must report the real client's; without this the adapter refused it ("Unsupported database type (object)").
  getPrototypeOf() {
    return Object.getPrototypeOf(real()) as object;
  },
});

export { schema };
