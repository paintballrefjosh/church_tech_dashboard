import { createPool } from "@church/shared/db";
import { drizzle } from "drizzle-orm/node-postgres";

// DATABASE_URL (or the old COCKROACH_URL). The shared factory adds an error
// handler (a dying database node must not crash the worker), timeouts, retry of
// statements that are safe to repeat, and TLS from the URL.
export const pool = createPool({ name: "monitor", max: 5 });
export const db = drizzle(pool);
