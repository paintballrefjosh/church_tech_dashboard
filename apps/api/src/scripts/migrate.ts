/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import * as path from "node:path";

async function main() {
  const url = process.env.COCKROACH_URL;
  if (!url) throw new Error("COCKROACH_URL is not set");

  const migrationsFolder = path.resolve(__dirname, "../../migrations");
  console.log(`[migrate] applying migrations from ${migrationsFolder}`);

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder });
  await pool.end();
  console.log("[migrate] done");
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
