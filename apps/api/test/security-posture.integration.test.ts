import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { SecurityPostureService } from "../src/security-posture/security-posture.service";
import * as schema from "../src/db/schema";

/**
 * The queries behind the Security overview, against a real engine (run on CockroachDB and YugabyteDB; see
 * db-stores.integration.test.ts for the setup). It adds and removes its own rows only, so the counts are checked as
 * "at least what was added" and the database may hold other data.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("security posture against a real database", () => {
  let pool: Pool;
  let service: SecurityPostureService;
  const settingsValues: Record<string, unknown> = {};
  let insertedGroup: string | null = null;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 4 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email IN ('admin@local', 'posture-a@test.local', 'posture-b@test.local')`);
    service = new SecurityPostureService(db as never, { get: async (k: string) => settingsValues[k] } as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM api_tokens WHERE name LIKE 'posture-test-%'`).catch(() => undefined);
    await q(`DELETE FROM users WHERE email IN ('admin@local', 'posture-a@test.local', 'posture-b@test.local')`).catch(() => undefined);
    if (insertedGroup) await q(`DELETE FROM groups WHERE id = $1`, [insertedGroup]).catch(() => undefined);
    await pool?.end();
  });

  it("answers on an empty-ish site without throwing, with plain numbers", async () => {
    const f = await service.facts();
    for (const n of [f.admins.total, f.users.total, f.pendingApprovals, f.ciscoUnpinned, f.apiTokens.active, f.apiTokens.idle]) expect(typeof n).toBe("number");
    expect(f.auditRetentionDays).toBe(365);
    expect(f.siteUrlSet).toBe(process.env.APP_URL ? true : false);
    expect(f.smtpConfigured).toBe(false);
    expect(f.defaultAdminPassword).toBe(false);
  });

  it("sees the install password, administrators without two-factor, pending accounts and risky tokens", async () => {
    const boot = (await q(`INSERT INTO users (email, must_change_password) VALUES ('admin@local', true) RETURNING id`)).rows[0].id;
    const a = (await q(`INSERT INTO users (email) VALUES ('posture-a@test.local') RETURNING id`)).rows[0].id;
    await q(`INSERT INTO users (email, approval_status) VALUES ('posture-b@test.local', 'pending')`);
    let gid: string = (await q(`SELECT id FROM groups WHERE name = 'admin' LIMIT 1`)).rows[0]?.id;
    if (!gid) {
      gid = (await q(`INSERT INTO groups (name) VALUES ('admin') RETURNING id`)).rows[0].id;
      insertedGroup = gid;
    }
    await q(`INSERT INTO group_memberships (user_id, group_id) VALUES ($1, $3), ($2, $3)`, [boot, a, gid]);
    await q(`INSERT INTO api_tokens (name, token_hash, user_id, allow_operational) VALUES ('posture-test-never', 'h-never-' || gen_random_uuid(), $1, true)`, [a]);
    await q(
      `INSERT INTO api_tokens (name, token_hash, user_id, expires_at, created_at) VALUES ('posture-test-old', 'h-old-' || gen_random_uuid(), $1, now() + interval '30 days', now() - interval '200 days')`,
      [a],
    );
    await q(`INSERT INTO api_tokens (name, token_hash, user_id, revoked_at) VALUES ('posture-test-revoked', 'h-rev-' || gen_random_uuid(), $1, now())`, [a]);

    settingsValues["microsoft.allowed_domains"] = " church.org, ,other.org ";
    settingsValues["auth.require_totp_admin"] = true;
    const f = await service.facts();
    expect(f.defaultAdminPassword).toBe(true);
    expect(f.admins.total).toBeGreaterThanOrEqual(2);
    expect(f.admins.withoutTotp).toBeGreaterThanOrEqual(2);
    expect(f.pendingApprovals).toBeGreaterThanOrEqual(1);
    expect(f.apiTokens.neverExpire).toBeGreaterThanOrEqual(1);
    expect(f.apiTokens.operational).toBeGreaterThanOrEqual(1);
    expect(f.apiTokens.idle).toBeGreaterThanOrEqual(1);
    expect(f.signIn.microsoft.allowedDomains).toBe(2);
    expect(f.requireTotpAdmin).toBe(true);
  });

  it("reads the latest finished backup as epoch milliseconds, and schedules", async () => {
    await q(`DELETE FROM backups WHERE name LIKE 'posture-test-%'`);
    const none = await service.facts();
    await q(`INSERT INTO backups (name, kind, status, s3_key) VALUES ('posture-test-ready', 'manual', 'ready', 'k-posture')`);
    await q(`INSERT INTO backups (name, kind, status, s3_key, created_at) VALUES ('posture-test-failed', 'manual', 'failed', 'k-posture-2', now() + interval '1 day')`);
    const f = await service.facts();
    expect(f.backups.lastReadyAt).not.toBeNull();
    expect(Math.abs((f.backups.lastReadyAt as number) - Date.now())).toBeLessThan(5 * 60_000);
    expect(none.backups.lastReadyAt === null || typeof none.backups.lastReadyAt === "number").toBe(true);
    await q(`DELETE FROM backups WHERE name LIKE 'posture-test-%'`);
  });

  it("reads the backup checks: last pass as epoch milliseconds, whether the newest failed, how many recent ones failed", async () => {
    await q(`DELETE FROM backups WHERE name LIKE 'posture-test-%'`);
    const none = await service.facts();
    await q(`INSERT INTO backups (name, kind, status, s3_key, created_at, verified_at) VALUES ('posture-test-ok', 'manual', 'ready', 'k-pc-1', now() - interval '2 hours', now() - interval '1 hour')`);
    const passing = await service.facts();
    expect(Math.abs((passing.backupChecks.lastPassedAt as number) - (Date.now() - 3_600_000))).toBeLessThan(5 * 60_000);
    expect(passing.backupChecks.newestFailing).toBe(false);
    expect(passing.backupChecks.failing).toBe(none.backupChecks.failing);
    await q(`INSERT INTO backups (name, kind, status, s3_key, created_at, verify_error) VALUES ('posture-test-bad', 'manual', 'ready', 'k-pc-2', now() + interval '1 hour', 'damaged')`);
    const failing = await service.facts();
    expect(failing.backupChecks.newestFailing).toBe(true);
    expect(failing.backupChecks.failing).toBe(none.backupChecks.failing + 1);
    await q(`DELETE FROM backups WHERE name LIKE 'posture-test-%'`);
  });

  it("produces a report whose first line is the install password", async () => {
    const r = await service.report();
    expect(r.checks[0]).toMatchObject({ id: "default-admin-password", severity: "critical" });
  });
});
