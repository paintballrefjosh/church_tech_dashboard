/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import * as schema from "../db/schema";

/**
 * Resets the bootstrap admin (email "admin@local") to password "admin" with
 * must_change_password=true. Intended for development and CI regression runs.
 * If the user doesn't exist yet, this is a no-op — run seed.js first.
 */
async function main() {
  const url = process.env.COCKROACH_URL;
  if (!url) throw new Error("COCKROACH_URL is not set");

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, "admin@local"))
    .limit(1);

  if (!user) {
    console.log("[reset-admin] no admin@local user found — run seed.js first");
    await pool.end();
    return;
  }

  const hash = await argon2.hash("admin", { type: argon2.argon2id });
  await db
    .insert(schema.credentials)
    .values({ userId: user.id, passwordHash: hash })
    .onConflictDoUpdate({
      target: schema.credentials.userId,
      set: { passwordHash: hash, updatedAt: new Date() },
    });
  await db
    .update(schema.users)
    .set({ mustChangePassword: true, updatedAt: new Date() })
    .where(eq(schema.users.id, user.id));

  console.log("[reset-admin] admin@local password reset to 'admin', must_change_password=true");
  await pool.end();
}

main().catch((err) => {
  console.error("[reset-admin] failed", err);
  process.exit(1);
});
