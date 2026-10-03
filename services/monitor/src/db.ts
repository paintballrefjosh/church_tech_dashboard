import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const url = process.env.COCKROACH_URL;
if (!url) throw new Error("COCKROACH_URL is not set");

export const pool = new Pool({ connectionString: url });
export const db = drizzle(pool);
