import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./db-schema";

const url = process.env.COCKROACH_URL;
if (!url) {
  throw new Error("COCKROACH_URL is required");
}

const pool = new Pool({ connectionString: url, max: 5 });
export const db = drizzle(pool, { schema });
export { schema };
