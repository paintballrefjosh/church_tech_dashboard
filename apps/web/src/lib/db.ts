import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./db-schema";

let _pool: Pool | null = null;
let _db: NodePgDatabase<typeof schema> | null = null;

function getPool(): Pool {
  if (_pool) return _pool;
  // DATABASE_URL; COCKROACH_URL is the pre-Yugabyte name, still accepted.
  const url = process.env.DATABASE_URL || process.env.COCKROACH_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  _pool = new Pool({ connectionString: url, max: 5 });
  return _pool;
}

/**
 * Lazily-initialised drizzle client. Wrapping in a Proxy means importing this
 * module does not connect to or even read DATABASE_URL at build time — only
 * when a query actually runs.
 */
export const db = new Proxy({} as NodePgDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    if (!_db) _db = drizzle(getPool(), { schema });
    return Reflect.get(_db as object, prop, receiver);
  },
});

export { schema };
