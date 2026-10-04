import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

// DATABASE_URL; COCKROACH_URL is the pre-Yugabyte name, still accepted.
const url = process.env.DATABASE_URL || process.env.COCKROACH_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const pool = new Pool({ connectionString: url });
export const db = drizzle(pool);
