import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { RetentionService } from "../src/retention/retention.service";
import { AuditService } from "../src/audit/audit.service";
import * as schema from "../src/db/schema";

/**
 * The age-based clean-up against a real database (see db-stores.integration.test.ts for the setup). It empties the
 * tables it touches, so never point it at a database you care about.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("retention against a real database", () => {
  let pool: Pool;
  let userId = "";
  let settingsValues: Record<string, unknown> = {};
  let retention: RetentionService;
  let audit: AuditService;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const count = async (table: string) => Number((await q(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    for (const t of ["notifications", "activity_events", "audit_log", "monitor_incidents", "backup_operations"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM monitors WHERE name = 'retention-test'`);
    await q(`DELETE FROM users WHERE email = 'retention@test.local'`);
    userId = (await q(`INSERT INTO users (email) VALUES ('retention@test.local') RETURNING id`)).rows[0].id;
    const settings = { get: async (k: string) => settingsValues[k] };
    const jobs = { register: () => undefined };
    retention = new RetentionService(db as never, settings as never, jobs as never);
    audit = new AuditService(db as never, settings as never, jobs as never, { get: async () => null, set: async () => undefined } as never);
  });
  afterAll(async () => {
    await pool?.end();
  });

  const seed = async (n: number, daysOld: number) => {
    await q(
      `INSERT INTO notifications (recipient_user_id, kind, title, created_at)
       SELECT $1, 'test', 'n' || g, now() - ($2 || ' days')::interval FROM generate_series(1, $3) g`,
      [userId, String(daysOld), n],
    );
    await q(
      `INSERT INTO activity_events (action, resource_type, title, ts)
       SELECT 'x', 'ticket', 'a' || g, now() - ($1 || ' days')::interval FROM generate_series(1, $2) g`,
      [String(daysOld), n],
    );
  };

  it("removes only what is older than the window, across several batches", async () => {
    await seed(1500, 400);
    await seed(20, 10);
    settingsValues = { "notifications.retention_days": 180, "activity.retention_days": 90 };
    const out = await retention.pruneOnce();
    expect(out).toMatchObject({ notifications: 1500, activity: 1500 });
    expect(await count("notifications")).toBe(20);
    expect(await count("activity_events")).toBe(20);
  });

  it("keeps everything when a window is 0 or unset", async () => {
    await seed(30, 900);
    settingsValues = { "notifications.retention_days": 0 };
    expect(await retention.pruneOnce()).toMatchObject({ notifications: 0, activity: 0 });
    expect(await count("notifications")).toBe(50);
    expect(await count("activity_events")).toBe(50);
  });

  it("removes only FINISHED monitoring history and runtime rows past their window", async () => {
    const monitorId = (await q(`INSERT INTO monitors (name, kind, target) VALUES ('retention-test', 'tcp', 'x:1') RETURNING id`)).rows[0].id;
    // An incident open for 2 years is still open; a resolved old one goes; a resolved recent one stays.
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at) VALUES ($1, now() - interval '800 days')`, [monitorId]);
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at) VALUES ($1, now() - interval '800 days', now() - interval '700 days')`, [monitorId]);
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at) VALUES ($1, now() - interval '20 days', now() - interval '10 days')`, [monitorId]);
    await q(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, 'reset', 'retention-old', now() - interval '60 days')`, [userId]);
    await q(`INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, 'reset', 'retention-live', now() + interval '1 day')`, [userId]);
    await q(`INSERT INTO backup_operations (kind, status, started_at, finished_at) VALUES ('backup', 'done', now() - interval '400 days', now() - interval '400 days')`);
    await q(`INSERT INTO backup_operations (kind, status, started_at) VALUES ('backup', 'running', now() - interval '400 days')`);

    settingsValues = { "monitoring.history_retention_days": 365 };
    const out = await retention.pruneOnce();
    expect(out).toMatchObject({ incidents: 1, authTokens: 1, backupOperations: 1 });
    expect(await count("monitor_incidents")).toBe(2);
    expect(Number((await q(`SELECT count(*) AS n FROM auth_tokens WHERE token_hash LIKE 'retention-%'`)).rows[0].n)).toBe(1);
    expect(await count("backup_operations")).toBe(1);

    settingsValues = { "monitoring.history_retention_days": 0 };
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at) VALUES ($1, now() - interval '800 days', now() - interval '700 days')`, [monitorId]);
    expect((await retention.pruneOnce()).incidents).toBe(0);
  });

  it("prunes the audit log in batches too", async () => {
    await q(
      `INSERT INTO audit_log (action, resource_type, ts) SELECT 'x', 'y', now() - interval '800 days' FROM generate_series(1, 2300)`,
    );
    await q(`INSERT INTO audit_log (action, resource_type, ts) SELECT 'x', 'y', now() FROM generate_series(1, 7)`);
    settingsValues = { "audit.retention_days": 365 };
    await (audit as unknown as { pruneOnce(): Promise<void> }).pruneOnce();
    expect(await count("audit_log")).toBe(7);
  });
});
