import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { SessionsService } from "../src/auth/sessions.service";
import * as schema from "../src/db/schema";

/**
 * Browser sessions against a real database (see db-stores.integration.test.ts for the setup): listing, ending one,
 * ending the others, the first-use insert, and the prune. It deletes the sessions of its own test users only.
 */
const url = process.env.TEST_DATABASE_URL;
const A = "0b0e2c1e-8c3a-4f0e-9d57-3f1b6f6f4a11";
const B = "7d9a1f3c-2e44-4b8e-a0aa-5c1d2e3f4a55";
const C = "c4f1d2a9-1b7e-4c55-8a3d-9e0f1a2b3c4d";
const D = "d3a7b1c5-6e29-4f10-b8c4-2a9e7d5f1b30";

describe.skipIf(!url)("sessions against a real database", () => {
  let pool: Pool;
  let sessions: SessionsService;
  let me = "";
  let other = "";
  const invalidated: string[] = [];
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  const settle = () => new Promise((r) => setTimeout(r, 150));

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 5 });
    const db = drizzle(pool, { schema });
    await q(`DELETE FROM users WHERE email IN ('sessions-a@test.local', 'sessions-b@test.local')`);
    me = (await q(`INSERT INTO users (email) VALUES ('sessions-a@test.local') RETURNING id`)).rows[0].id;
    other = (await q(`INSERT INTO users (email) VALUES ('sessions-b@test.local') RETURNING id`)).rows[0].id;
    const auth = { invalidateUser: (id: string) => void invalidated.push(id) };
    sessions = new SessionsService(db as never, auth as never, { register: () => undefined } as never);
  });
  afterAll(async () => {
    await q(`DELETE FROM users WHERE email IN ('sessions-a@test.local', 'sessions-b@test.local')`).catch(() => undefined);
    await pool?.end();
  });

  it("creates a row the first time a session is seen, and describes its browser", async () => {
    sessions.touch(me, A, "203.0.113.7", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0");
    sessions.touch(me, B, "198.51.100.2", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1");
    await settle();
    const list = await sessions.list(me, A);
    expect(list.map((s) => s.id).sort()).toEqual([A, B].sort());
    const mine = list.find((s) => s.id === A)!;
    expect(mine.current).toBe(true);
    expect(mine.browser.label).toBe("Firefox on Windows");
    expect(mine.ip).toBe("203.0.113.7");
    expect(list.find((s) => s.id === B)!.current).toBe(false);
  });

  it("does not write again within the throttle window", async () => {
    await q(`UPDATE user_sessions SET ip = 'x' WHERE id = $1`, [A]);
    sessions.touch(me, A, "203.0.113.99", null);
    await settle();
    expect((await q(`SELECT ip FROM user_sessions WHERE id = $1`, [A])).rows[0].ip).toBe("x");
  });

  it("ends one session, for its owner only", async () => {
    expect(await sessions.revoke(other, B)).toBe(false);
    invalidated.length = 0;
    expect(await sessions.revoke(me, B)).toBe(true);
    expect(invalidated).toEqual([me]);
    expect(await sessions.revoke(me, B)).toBe(false);
    expect((await sessions.list(me, A)).map((s) => s.id)).toEqual([A]);
  });

  it("never revives an ended session when its cookie shows up again", async () => {
    sessions.touch(me, B, "1.2.3.4", null, Date.now() + 10 * 60_000);
    await settle();
    const row = (await q(`SELECT revoked_at, ip FROM user_sessions WHERE id = $1`, [B])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.ip).not.toBe("1.2.3.4");
  });

  it("ends the current session even before its first write landed", async () => {
    await sessions.revokeCurrent(me, C);
    const row = (await q(`SELECT user_id, revoked_at FROM user_sessions WHERE id = $1`, [C])).rows[0];
    expect(row.user_id).toBe(me);
    expect(row.revoked_at).not.toBeNull();
  });

  it("ends every other session and keeps the asking one", async () => {
    sessions.touch(me, D, null, null);
    await settle();
    expect((await sessions.list(me, A)).map((s) => s.id).sort()).toEqual([A, D].sort());
    expect(await sessions.revokeOthers(me, A)).toBe(1);
    expect((await sessions.list(me, A)).map((s) => s.id)).toEqual([A]);
  });

  it("lists only live sessions and prunes idle and long-ended ones", async () => {
    await q(`UPDATE user_sessions SET last_seen_at = now() - interval '20 days' WHERE id = $1`, [A]);
    expect(await sessions.list(me, null)).toHaveLength(0);
    await q(`UPDATE user_sessions SET last_seen_at = now() - interval '40 days' WHERE id = $1`, [A]);
    await q(`UPDATE user_sessions SET revoked_at = now() - interval '100 days' WHERE id = $1`, [B]);
    await q(`UPDATE user_sessions SET revoked_at = now() - interval '5 days' WHERE id = $1`, [D]);
    const removed = await sessions.prune();
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = (await q(`SELECT id FROM user_sessions WHERE user_id = $1`, [me])).rows.map((r) => r.id);
    expect(left).not.toContain(A);
    expect(left).not.toContain(B);
    expect(left).toContain(D);
  });
});
