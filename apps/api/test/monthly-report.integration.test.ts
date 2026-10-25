import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema";
import { ReportsService } from "../src/reports/reports.service";

/** The monthly report's queries against a real database (CockroachDB and YugabyteDB; empties the tables it seeds). */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("monthly report against a real database", () => {
  let pool: Pool;
  let reports: ReportsService;
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 3 });
    const db = drizzle(pool, { schema });
    for (const t of ["monitor_incidents", "renewals"]) await q(`DELETE FROM ${t}`);
    await q(`DELETE FROM monitors WHERE name LIKE 'report-test%'`);
    await q(`DELETE FROM ticket_comments`);
    await q(`DELETE FROM tickets`);
    await q(`DELETE FROM users WHERE email = 'report-test@test.local'`);
    const user = (await q(`INSERT INTO users (email) VALUES ('report-test@test.local') RETURNING id`)).rows[0].id;
    const mon = (await q(`INSERT INTO monitors (name, kind, target) VALUES ('report-test stream', 'tcp', 'x:1') RETURNING id`)).rows[0].id;
    // 10 hours down in October (UTC site clock), plus one that started in September and ended on 1 October 02:00.
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at, acknowledged_at) VALUES ($1, '2026-10-10 00:00', '2026-10-10 10:00', '2026-10-10 00:05')`, [mon]);
    await q(`INSERT INTO monitor_incidents (monitor_id, started_at, resolved_at) VALUES ($1, '2026-09-30 22:00', '2026-10-01 02:00')`, [mon]);
    await q(`INSERT INTO tickets (title, created_by_user_id, created_at, resolved_at, response_breached_at) VALUES ('report-test a', $1, '2026-10-02', '2026-10-02 06:00', '2026-10-02 03:00')`, [user]);
    await q(`INSERT INTO tickets (title, created_by_user_id, created_at) VALUES ('report-test b', $1, '2026-10-20')`, [user]);
    await q(`INSERT INTO renewals (name, renews_on) VALUES ('report-test CCLI', '2026-11-15'), ('report-test later', '2027-01-01')`);
    const settings = { get: async () => undefined };
    const delivery = { zone: async () => "UTC" };
    reports = new ReportsService(db as never, { register: () => undefined } as never, {} as never, {} as never, delivery as never, settings as never);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("adds up October", async () => {
    const r = await reports.build("2026-10", new Date("2026-11-01T09:00:00Z"));
    const svc = r.services.find((s) => s.name === "report-test stream")!;
    // 12 of 744 hours down.
    expect(svc.uptime).toBe(Math.round((1 - 12 / 744) * 10_000) / 100);
    expect(svc).toMatchObject({ incidents: 2, longestMinutes: 600 });
    expect(r.incidents).toEqual({ total: 1, acknowledged: 1 });
    expect(r.tickets).toMatchObject({ opened: 2, resolved: 1, medianResolutionHours: 6, responseBreaches: 1, resolutionBreaches: 0, openAtEnd: 1 });
    expect(r.renewalsNextMonth).toEqual([{ name: "report-test CCLI", renewsOn: "2026-11-15" }]);
  });
});
