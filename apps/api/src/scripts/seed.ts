/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_DESCRIPTIONS,
} from "@church/shared";
import * as schema from "../db/schema";

/**
 * Idempotent seed. Safe to re-run.
 *
 * On a fresh DB it creates:
 *   - all permission rows (from packages/shared)
 *   - the three system roles (admin, support_engineer, user) with default permissions
 *   - one bootstrap admin: email "admin", password "admin", with must_change_password=true
 *
 * On subsequent runs it only inserts missing rows and never overwrites passwords.
 */
async function main() {
  const url = process.env.COCKROACH_URL;
  if (!url) throw new Error("COCKROACH_URL is not set");

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  console.log("[seed] permissions");
  for (const key of ALL_PERMISSIONS) {
    await db.insert(schema.permissions).values({ key, description: null }).onConflictDoNothing();
  }

  console.log("[seed] system roles");
  const roleKeyToId = new Map<string, string>();
  for (const key of Object.values(DEFAULT_ROLES)) {
    let [row] = await db.select().from(schema.roles).where(eq(schema.roles.key, key)).limit(1);
    if (!row) {
      [row] = await db
        .insert(schema.roles)
        .values({
          key,
          description: DEFAULT_ROLE_DESCRIPTIONS[key as keyof typeof DEFAULT_ROLE_DESCRIPTIONS] ?? null,
          isSystem: true,
        })
        .returning();
    }
    if (!row) throw new Error(`Failed to upsert role ${key}`);
    roleKeyToId.set(key, row.id);
  }

  console.log("[seed] role -> permissions");
  for (const [roleKey, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const roleId = roleKeyToId.get(roleKey);
    if (!roleId) continue;
    for (const permissionKey of perms) {
      await db
        .insert(schema.rolePermissions)
        .values({ roleId, permissionKey })
        .onConflictDoNothing();
    }
  }

  // ---- bootstrap admin ----
  // Username "admin" is stored as email "admin@local" so it survives the email-unique
  // constraint and ordinary user-management code can treat it like any other account.
  // The login form normalises bare "admin" to "admin@local" so the user just types
  // "admin / admin" the first time, then is forced to change the password.
  const bootstrapEmail = "admin@local";
  const bootstrapPassword = "admin";

  let [adminUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, bootstrapEmail))
    .limit(1);

  if (!adminUser) {
    console.log(`[seed] creating bootstrap admin ${bootstrapEmail}`);
    [adminUser] = await db
      .insert(schema.users)
      .values({
        email: bootstrapEmail,
        name: "Administrator",
        isActive: true,
        mustChangePassword: true,
      })
      .returning();
    if (!adminUser) throw new Error("Failed to insert bootstrap admin");
    const hash = await argon2.hash(bootstrapPassword, { type: argon2.argon2id });
    await db.insert(schema.credentials).values({ userId: adminUser.id, passwordHash: hash });
    console.log("");
    console.log("  ╔══════════════════════════════════════════════════════════╗");
    console.log("  ║  Default sign-in:  admin  /  admin                       ║");
    console.log("  ║  You will be prompted to change the password on login.   ║");
    console.log("  ╚══════════════════════════════════════════════════════════╝");
    console.log("");
  } else {
    console.log(`[seed] bootstrap admin already exists (${bootstrapEmail}) — not touching password`);
  }

  const adminRoleId = roleKeyToId.get(DEFAULT_ROLES.ADMIN);
  if (adminRoleId) {
    await db
      .insert(schema.userRoles)
      .values({ userId: adminUser.id, roleId: adminRoleId })
      .onConflictDoNothing();
  }

  await pool.end();
  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
