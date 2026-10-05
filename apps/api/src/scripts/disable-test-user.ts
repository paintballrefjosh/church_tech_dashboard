/* eslint-disable no-console */
import type { Pool } from "pg";
import { createPool } from "@church/shared/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { databaseUrl } from "../db/connection";

/**
 * Teardown counterpart to reset-test-user: disables the regression test user
 * (regression-test@local) once a test run is over. The account is created with
 * a KNOWN password and full admin-group access, so leaving it enabled while
 * idle is both a standing credential risk and a live notification recipient
 * (admin-group fan-outs would reach it). Disabling (is_active=false) locks
 * sign-in and, per NotificationsService, drops it from all recipient lookups.
 *
 * Idempotent and safe to run when the user doesn't exist (0 rows updated).
 * reset-test-user re-enables it at the start of the next run. The bootstrap
 * admin is NEVER touched.
 */
const TEST_EMAIL = "regression-test@local";

async function main() {
  const url = databaseUrl();

  const pool = createPool({ name: "disable-test-user", url: url, max: 4 });
  const db = drizzle(pool, { schema });

  const updated = await db
    .update(schema.users)
    .set({ isActive: false })
    .where(eq(schema.users.email, TEST_EMAIL))
    .returning({ id: schema.users.id });

  if (updated.length > 0) {
    console.log(`[disable-test-user] ${TEST_EMAIL} disabled (is_active=false).`);
  } else {
    console.log(`[disable-test-user] ${TEST_EMAIL} not present — nothing to do.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("[disable-test-user] failed", err);
  process.exit(1);
});
