/* eslint-disable no-console */
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import * as fs from "node:fs";
import argon2 from "argon2";
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLES,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE_DESCRIPTIONS,
} from "@church/shared";
import * as schema from "../db/schema";

async function main() {
  const url = process.env.COCKROACH_URL;
  if (!url) throw new Error("COCKROACH_URL is not set");

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  console.log("[seed] inserting permissions");
  for (const key of ALL_PERMISSIONS) {
    await db.insert(schema.permissions).values({ key, description: null }).onConflictDoNothing();
  }

  console.log("[seed] inserting default roles");
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

  console.log("[seed] mapping role -> permissions");
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

  const bootstrapEmail = process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@church.local";
  let bootstrapPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || "";
  let generated = false;
  if (!bootstrapPassword) {
    bootstrapPassword = randomBytes(18).toString("base64url");
    generated = true;
  }

  console.log(`[seed] bootstrap admin: ${bootstrapEmail}`);
  let [adminUser] = await db.select().from(schema.users).where(eq(schema.users.email, bootstrapEmail)).limit(1);
  if (!adminUser) {
    [adminUser] = await db
      .insert(schema.users)
      .values({ email: bootstrapEmail, name: "Bootstrap Admin", isActive: true })
      .returning();
    if (!adminUser) throw new Error("Failed to insert bootstrap admin");
    const hash = await argon2.hash(bootstrapPassword, { type: argon2.argon2id });
    await db.insert(schema.credentials).values({ userId: adminUser.id, passwordHash: hash });
  } else if (generated) {
    const hash = await argon2.hash(bootstrapPassword, { type: argon2.argon2id });
    await db
      .insert(schema.credentials)
      .values({ userId: adminUser.id, passwordHash: hash })
      .onConflictDoUpdate({
        target: schema.credentials.userId,
        set: { passwordHash: hash, updatedAt: new Date() },
      });
  }

  const adminRoleId = roleKeyToId.get(DEFAULT_ROLES.ADMIN);
  if (adminRoleId) {
    await db
      .insert(schema.userRoles)
      .values({ userId: adminUser.id, roleId: adminRoleId })
      .onConflictDoNothing();
  }

  // Persist generated credentials for `make seed-credentials` to read.
  const credLine = generated
    ? `Bootstrap admin\n  email:    ${bootstrapEmail}\n  password: ${bootstrapPassword}\n\nKeep this safe. Run \`make seed-credentials\` to reprint, or set BOOTSTRAP_ADMIN_PASSWORD in .env to pin a known value.`
    : `Bootstrap admin\n  email:    ${bootstrapEmail}\n  password: (set via BOOTSTRAP_ADMIN_PASSWORD)`;
  try {
    fs.writeFileSync("/tmp/bootstrap-credentials.txt", credLine + "\n", { mode: 0o600 });
  } catch {
    // best-effort
  }

  console.log("");
  console.log(credLine);
  console.log("");

  // Also create a fingerprint so callers can verify which seed run produced these creds.
  const fp = createHash("sha256").update(bootstrapEmail + ":" + bootstrapPassword).digest("hex").slice(0, 12);
  console.log(`[seed] credentials fingerprint: ${fp}`);

  await pool.end();
  console.log("[seed] done");
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
