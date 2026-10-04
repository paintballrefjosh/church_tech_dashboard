/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import {
  ALL_PERMISSIONS,
  DEFAULT_GROUPS,
  DEFAULT_GROUP_DESCRIPTIONS,
  DEFAULT_GROUP_MODULE_ACCESS,
} from "@church/shared";
import * as schema from "../db/schema";
import { databaseUrl } from "../db/connection";

/**
 * Idempotent seed. Safe to re-run.
 *
 * On a fresh DB it creates:
 *   - all permission rows (from packages/shared) — kept for legacy
 *     references in audit/admin matrix; new code reads modules, not perms
 *   - the three default groups (admin, support_engineer, user) with
 *     is_system=true on admin + user
 *   - per-group module access rows from DEFAULT_GROUP_MODULE_ACCESS
 *   - one bootstrap admin: email "admin", password "admin",
 *     with must_change_password=true, member of the admin group
 *
 * On subsequent runs only inserts missing rows; never overwrites passwords.
 */
async function main() {
  const url = databaseUrl();

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  console.log("[seed] permissions");
  for (const key of ALL_PERMISSIONS) {
    await db.insert(schema.permissions).values({ key, description: null }).onConflictDoNothing();
  }

  console.log("[seed] default groups");
  const groupNameToId = new Map<string, string>();
  for (const name of Object.values(DEFAULT_GROUPS)) {
    const isSystem = name === DEFAULT_GROUPS.ADMIN || name === DEFAULT_GROUPS.USER;
    let [row] = await db.select().from(schema.groups).where(eq(schema.groups.name, name)).limit(1);
    if (!row) {
      [row] = await db
        .insert(schema.groups)
        .values({
          name,
          description: DEFAULT_GROUP_DESCRIPTIONS[name as keyof typeof DEFAULT_GROUP_DESCRIPTIONS] ?? null,
          isManaged: false,
          isSystem,
        })
        .returning();
    } else if (isSystem && !row.isSystem) {
      // Existing row predates the is_system column. Flip the flag so the
      // delete-protection guards engage.
      [row] = await db
        .update(schema.groups)
        .set({ isSystem: true, updatedAt: new Date() })
        .where(eq(schema.groups.id, row.id))
        .returning();
    }
    if (!row) throw new Error(`Failed to upsert group ${name}`);
    groupNameToId.set(name, row.id);
  }

  console.log("[seed] group module access");
  for (const [groupName, access] of Object.entries(DEFAULT_GROUP_MODULE_ACCESS)) {
    const groupId = groupNameToId.get(groupName);
    if (!groupId) continue;
    for (const [moduleKey, tier] of Object.entries(access)) {
      await db
        .insert(schema.groupModuleAccess)
        .values({ groupId, moduleKey, tier })
        .onConflictDoNothing();
    }
  }

  // ---- bootstrap admin ----
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

  const adminGroupId = groupNameToId.get(DEFAULT_GROUPS.ADMIN);
  if (adminGroupId) {
    await db
      .insert(schema.groupMemberships)
      .values({ userId: adminUser.id, groupId: adminGroupId })
      .onConflictDoNothing();
  }

  await pool.end();
  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
