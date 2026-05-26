/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { DEFAULT_ROLES } from "@church/shared";
import * as schema from "../db/schema";

/**
 * Creates or resets a dedicated regression test user (email
 * "regression-test@local") to a known default state for the automated
 * smoke + e2e suites. The bootstrap admin user is NEVER touched by this
 * script — that's the whole point.
 *
 * Default state after running:
 *   email                 regression-test@local
 *   password              regression-default-pwd
 *   must_change_password  true       (so the change-password gate can be tested)
 *   roles                 admin      (so admin-scoped endpoints can be exercised)
 *   notes / other rows    DELETED via FK cascade
 */
const TEST_EMAIL = "regression-test@local";
const TEST_DEFAULT_PASSWORD = "regression-default-pwd";

async function main() {
  const url = process.env.COCKROACH_URL;
  if (!url) throw new Error("COCKROACH_URL is not set");

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  // Delete first so cascades wipe any leftover state (notes, sessions, etc.).
  await db.delete(schema.users).where(eq(schema.users.email, TEST_EMAIL));

  const [user] = await db
    .insert(schema.users)
    .values({
      email: TEST_EMAIL,
      name: "Regression Test User",
      isActive: true,
      mustChangePassword: true,
    })
    .returning();
  if (!user) throw new Error("Failed to insert test user");

  const hash = await argon2.hash(TEST_DEFAULT_PASSWORD, { type: argon2.argon2id });
  await db.insert(schema.credentials).values({ userId: user.id, passwordHash: hash });

  // Grant the admin role (must exist — seed.js creates it on first run).
  const [adminRole] = await db
    .select()
    .from(schema.roles)
    .where(eq(schema.roles.key, DEFAULT_ROLES.ADMIN))
    .limit(1);
  if (!adminRole) {
    throw new Error("admin role missing — run `make seed` first");
  }
  await db.insert(schema.userRoles).values({ userId: user.id, roleId: adminRole.id });

  console.log(`[reset-test-user] ${TEST_EMAIL} / ${TEST_DEFAULT_PASSWORD}  (must_change_password=true, role=admin)`);
  console.log("[reset-test-user] bootstrap admin NOT touched.");

  await pool.end();
}

main().catch((err) => {
  console.error("[reset-test-user] failed", err);
  process.exit(1);
});
